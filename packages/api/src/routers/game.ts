import { z } from "zod";
import { publicProcedure, router } from "../index";
import { TRPCError } from "@trpc/server";
import prisma from "@minesweeper/db";
import { env } from "@minesweeper/env/server";
import axios from "axios";
import {
  generateBoard,
  getCascade,
  calculateXP,
  validateGameLog,
  MINE_VALUE,
  SAFE_CELLS,
  type RevealedCell,
  type GameLogEntry,
} from "../lib/game";
import {
  generateGameStateProof,
  submitProofToKurier,
} from "../lib/proving";
import { proofQueue } from "../lib/queue";
import { CircuitKind } from "@minesweeper/proving_system/type";

export const gameRouter = router({
  // -----------------------------------------------------------------------
  // START GAME — Phase 1: The Commitment
  // -----------------------------------------------------------------------
  startGame: publicProcedure.mutation(async () => {
    console.log("[Game] Starting new game...");
    // 1. Fetch cryptographically secure seed from Kurier
    let seed: string;
    try {
      console.log(`[Game] Fetching seed from Kurier at ${env.KURIER_URL}...`);
      const seedResponse = await axios.post(
        `${env.KURIER_URL}/random-hash/${env.KURIER_API}`,
        {},
      );
      seed = seedResponse.data.hash;
      console.log(`[Game] Received seed: ${seed.slice(0, 16)}...`);
    } catch (error: any) {
      console.error("[Game] Kurier seed fetch failed:", error?.response?.data || error.message);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch seed from Kurier",
      });
    }

    // 2. Generate the board using the ZK circuit's oracle
    console.log("[Game] Generating board...");
    try {
      const { grid, merkleRoot } = await generateBoard(seed);
      console.log(`[Game] Board generated. Merkle Root: ${merkleRoot.slice(0, 16)}...`);

      // 3. Persist game + cells to database
      console.log("[Game] Persisting game to database...");
      const game = await prisma.game.create({
        data: {
          seed,
          merkleRoot,
          cells: {
            create: grid.map((cell: { index: string; value: string; salt: string }) => ({
              index: Number(cell.index),
              value: Number(cell.value),
              salt: cell.salt,
            })),
          },
        },
      });

      console.log(
        `[Game] Created game ${game.id} with root ${merkleRoot.slice(0, 16)}...`,
      );

      // 4. Return only the game ID and public Merkle root (no private state!)
      return {
        gameId: game.id,
        merkleRoot,
      };
    } catch (error: any) {
      console.error("[Game] Board generation or persistence failed:", error);
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: error.message || "Failed to initialize game",
      });
    }
  }),

  // -----------------------------------------------------------------------
  // REVEAL CELL — Phase 2: Optimistic Gameplay
  // -----------------------------------------------------------------------
  revealCell: publicProcedure
    .input(
      z.object({
        gameId: z.string().uuid(),
        index: z.number().int().min(0).max(80),
      }),
    )
    .mutation(async ({ input }) => {
      const { gameId, index } = input;
      console.log(`[Game] Revealing cell ${index} for game ${gameId}...`);

      // 1. Load game and verify it's in progress
      const game = await prisma.game.findUnique({
        where: { id: gameId },
        include: { cells: true },
      });

      if (!game) {
        console.error(`[Game] ${gameId} not found.`);
        throw new TRPCError({ code: "NOT_FOUND", message: "Game not found" });
      }
      if (game.status !== "IN_PROGRESS") {
        console.warn(`[Game] ${gameId} is already ${game.status}.`);
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Game is already ${game.status}`,
        });
      }

      // 2. Look up the requested cell
      const cell = game.cells.find((c) => c.index === index);
      if (!cell) {
        console.error(`[Game] Cell ${index} not found for ${gameId}.`);
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Cell ${index} not found`,
        });
      }

      // 3. Build the grid in the circuit's cell format for cascade resolution
      const gridForCascade = game.cells
        .sort((a, b) => a.index - b.index)
        .map((c) => ({
          index: c.index.toString(),
          value: c.value.toString(),
          salt: c.salt,
        }));

      // 4. Check for mine hit
      if (cell.value === MINE_VALUE) {
        console.log(`[Game] Player hit a mine at ${index}! Game Over.`);
        // Game over — defeat
        await prisma.game.update({
          where: { id: gameId },
          data: { status: "LOST" },
        });

        return {
          cells: [{ index: cell.index, value: cell.value }],
          gameOver: true,
          isVictory: false,
        };
      }

      // 5. Resolve cascade for safe cells
      console.log(`[Game] Cell ${index} is safe. Value: ${cell.value}.`);
      const revealedCells = getCascade(gridForCascade as any, index);
      console.log(`[Game] Cascaded into ${revealedCells.length} cells.`);

      return {
        cells: revealedCells,
        gameOver: false,
        isVictory: false,
      };
    }),

  // -----------------------------------------------------------------------
  // END GAME — Phase 3: Game Termination & Pre-Validation
  // -----------------------------------------------------------------------
  endGame: publicProcedure
    .input(
      z.object({
        gameId: z.string().uuid(),
        gameLog: z.array(
          z.object({
            index: z.number().int().min(0).max(80),
            value: z.number().int().min(0).max(9),
          }),
        ),
      }),
    )
    .mutation(async ({ input }) => {
      const { gameId, gameLog } = input;
      console.log(`[Game] Ending game ${gameId} with log length ${gameLog.length}...`);

      // 1. Load game
      const game = await prisma.game.findUnique({
        where: { id: gameId },
        include: { cells: true },
      });

      if (!game) {
        console.error(`[Game] ${gameId} not found.`);
        throw new TRPCError({ code: "NOT_FOUND", message: "Game not found" });
      }

      // 2. Programmatic sanity check — validate game log against DB
      const dbCells = game.cells.map((c) => ({
        index: c.index,
        value: c.value,
      }));
      console.log(`[Game] Validating game log...`);
      const validation = validateGameLog(gameLog, dbCells);
      if (!validation.valid) {
        console.error(`[Game] Validation failed: ${validation.reason}`);
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Game log validation failed: ${validation.reason}`,
        });
      }

      // 3. Determine victory/defeat and calculate XP
      const safeCellsRevealed = gameLog.filter(
        (e) => e.value !== MINE_VALUE,
      );
      const hitMine = gameLog.some((e) => e.value === MINE_VALUE);
      const isVictory = !hitMine && safeCellsRevealed.length >= SAFE_CELLS;
      console.log(`[Game] Victory: ${isVictory}, Revealed: ${safeCellsRevealed.length}/${SAFE_CELLS}.`);

      const revealedCells: RevealedCell[] = safeCellsRevealed.map((e) => ({
        index: e.index,
        value: e.value,
      }));
      const xp = calculateXP(revealedCells, isVictory);

      const status = isVictory ? "WON" : "LOST";

      // 4. Update game in database
      console.log(`[Game] Updating DB status to ${status}...`);
      await prisma.game.update({
        where: { id: gameId },
        data: {
          status,
          xp,
          proofStatus: "pending",
        },
      });

      // 5. Submit job to the proof generation queue (non-blocking)
      const gridForProof = game.cells
        .sort((a, b) => a.index - b.index)
        .map((c) => ({
          index: c.index.toString(),
          value: c.value.toString(),
          salt: c.salt,
        }));

      console.log(`[Game] Adding proof generation job for ${gameId} to the queue...`);
      await proofQueue.add(`proof-${gameId}`, {
        gameId,
        gameLog,
        gridForProof,
        merkleRoot: game.merkleRoot,
      });

      return {
        xp,
        status,
        isVictory,
        proofStatus: "pending",
      };
    }),

  // -----------------------------------------------------------------------
  // GET GAME — Poll for game state / proof status
  // -----------------------------------------------------------------------
  getGame: publicProcedure
    .input(z.object({ gameId: z.string().uuid() }))
    .query(async ({ input }) => {
      const game = await prisma.game.findUnique({
        where: { id: input.gameId },
        select: {
          id: true,
          merkleRoot: true,
          status: true,
          xp: true,
          proofStatus: true,
          createdAt: true,
        },
      });

      if (!game) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Game not found" });
      }

      return game;
    }),
});
