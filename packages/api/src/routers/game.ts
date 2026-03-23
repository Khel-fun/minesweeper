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
import { CircuitKind } from "@minesweeper/proving_system/type";

export const gameRouter = router({
  // -----------------------------------------------------------------------
  // START GAME — Phase 1: The Commitment
  // -----------------------------------------------------------------------
  startGame: publicProcedure.mutation(async () => {
    // 1. Fetch cryptographically secure seed from Kurier
    let seed: string;
    try {
      const seedResponse = await axios.post(
        `${env.KURIER_URL}/random-hash/${env.KURIER_API}`,
        {},
      );
      seed = seedResponse.data.hash;
    } catch (error) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch seed from Kurier",
      });
    }

    // 2. Generate the board using the ZK circuit's oracle
    const { grid, merkleRoot } = await generateBoard(seed);

    // 3. Persist game + cells to database
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

      // 1. Load game and verify it's in progress
      const game = await prisma.game.findUnique({
        where: { id: gameId },
        include: { cells: true },
      });

      if (!game) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Game not found" });
      }
      if (game.status !== "IN_PROGRESS") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Game is already ${game.status}`,
        });
      }

      // 2. Look up the requested cell
      const cell = game.cells.find((c) => c.index === index);
      if (!cell) {
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
      const revealedCells = getCascade(gridForCascade as any, index);

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

      // 1. Load game
      const game = await prisma.game.findUnique({
        where: { id: gameId },
        include: { cells: true },
      });

      if (!game) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Game not found" });
      }

      // 2. Programmatic sanity check — validate game log against DB
      const dbCells = game.cells.map((c) => ({
        index: c.index,
        value: c.value,
      }));
      const validation = validateGameLog(gameLog, dbCells);
      if (!validation.valid) {
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

      const revealedCells: RevealedCell[] = safeCellsRevealed.map((e) => ({
        index: e.index,
        value: e.value,
      }));
      const xp = calculateXP(revealedCells, isVictory);

      const status = isVictory ? "WON" : "LOST";

      // 4. Update game in database
      await prisma.game.update({
        where: { id: gameId },
        data: {
          status,
          xp,
          proofStatus: "pending",
        },
      });

      // 5. Trigger async proof generation (non-blocking)
      const gridForProof = game.cells
        .sort((a, b) => a.index - b.index)
        .map((c) => ({
          index: c.index.toString(),
          value: c.value.toString(),
          salt: c.salt,
        }));

      // Fire and forget — proof generation runs in background
      generateGameStateProof(
        gameLog as GameLogEntry[],
        gridForProof as any,
        game.merkleRoot,
      )
        .then(async ({ proofHex, publicInputs }) => {
          await prisma.game.update({
            where: { id: gameId },
            data: { proofHex, proofStatus: "generated" },
          });

          // Submit to Kurier for verification
          try {
            await submitProofToKurier(
              CircuitKind.GAME_STATE,
              proofHex,
              publicInputs,
            );
            await prisma.game.update({
              where: { id: gameId },
              data: { proofStatus: "verified" },
            });
          } catch (err) {
            console.error(`[ZK] Kurier verification failed for game ${gameId}:`, err);
            await prisma.game.update({
              where: { id: gameId },
              data: { proofStatus: "failed" },
            });
          }
        })
        .catch(async (err) => {
          console.error(`[ZK] Proof generation failed for game ${gameId}:`, err);
          await prisma.game.update({
            where: { id: gameId },
            data: { proofStatus: "failed" },
          });
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
