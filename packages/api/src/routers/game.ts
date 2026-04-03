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
import { enqueueProof } from "../lib/proofQueue";

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
      if(seed){ console.log(`[Game] Seed: ${seed}`); }
    } catch (error) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Failed to fetch seed from Kurier",
      });
    }

    // 2. Generate the board using the ZK circuit's oracle
    const { grid, merkleRoot } = await generateBoard(seed);

    // 3. Persist game + cells to database
    const game = await prisma.game.findUniqueOrThrow({
      where: { name: "minesweeper" },
    });

    const circuit = await prisma.circuit.findFirstOrThrow({
      where: { gameId: game.id, circuitName: "initialize_board" },
    });

    const session = await prisma.gameSession.create({
      data: {
        gameId: game.id,
        status: "STARTED",
        minesweeperSession: {
          create: {
            seed,
            merkleRoot,
            cells: grid.map((cell: { index: string; value: string; salt: string }) => ({
              index: Number(cell.index),
              value: Number(cell.value),
              salt: cell.salt,
            })),
          },
        },
      },
    });

    console.log(
      `[Game] Created game session ${session.id} with root ${merkleRoot.slice(0, 16)}...`,
    );

    // Enqueue INIT_BOARD proof generation (non-blocking)
    await enqueueProof({
      type: "INIT_BOARD",
      sessionId: session.id,
      gameId: game.id,
      circuitId: circuit.id,
      seed,
      merkleRoot,
    });

    // 4. Return only the game ID and public Merkle root (no private state!)
    return {
      gameId: session.id,
      merkleRoot,
    };
  }),

  // -----------------------------------------------------------------------
  // REVEAL CELL — Phase 2: Optimistic Gameplay
  // -----------------------------------------------------------------------
  revealCell: publicProcedure
    .input(
      z.object({
        gameId: z.uuid(),
        index: z.number().int().min(0).max(80),
      }),
    )
    .mutation(async ({ input }) => {
      const { gameId, index } = input;

      // 1. Load game and verify it's in progress
      const session = await prisma.gameSession.findUnique({
        where: { id: gameId },
        include: { minesweeperSession: true },
      });

      if (!session || !session.minesweeperSession) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Game session not found" });
      }
      if (session.status !== "IN_PROGRESS" && session.status !== "STARTED") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: `Game is already ${session.status}`,
        });
      }

      // If it was STARTED, mark it as IN_PROGRESS
      if (session.status === "STARTED") {
        await prisma.gameSession.update({
           where: { id: session.id },
           data: { status: "IN_PROGRESS" },
        });
      }

      const cells = session.minesweeperSession.cells as { index: number; value: number; salt: string }[];

      // 2. Look up the requested cell
      const cell = cells.find((c) => c.index === index);
      if (!cell) {
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: `Cell ${index} not found`,
        });
      }

      // 3. Build the grid in the circuit's cell format for cascade resolution
      const gridForCascade = cells
        .sort((a, b) => a.index - b.index)
        .map((c) => ({
          index: c.index.toString(),
          value: c.value.toString(),
          salt: c.salt,
        }));

      // 4. Check for mine hit
      if (cell.value === MINE_VALUE) {
        // Game over — defeat
        await prisma.gameSession.update({
          where: { id: session.id },
          data: { status: "FINISHED" },
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
      const session = await prisma.gameSession.findUnique({
        where: { id: gameId },
        include: { minesweeperSession: true },
      });

      if (!session || !session.minesweeperSession) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Game session not found" });
      }

      const cells = session.minesweeperSession.cells as { index: number; value: number; salt: string }[];

      // 2. Programmatic sanity check — validate game log against DB
      const dbCells = cells.map((c) => ({
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

      // 4. Update session
      await prisma.gameSession.update({
         where: { id: session.id },
         data: { status: "FINISHED" },
      });

      // 5. Trigger async proof generation (non-blocking)
      const circuit = await prisma.circuit.findFirstOrThrow({
        where: { gameId: session.gameId, circuitName: "game_state" },
      });

      const gridForProof = cells
        .sort((a, b) => a.index - b.index)
        .map((c) => ({
          index: c.index.toString(),
          value: c.value.toString(),
          salt: c.salt,
        }));

      // Fire and forget via BullMQ enqueue
      await enqueueProof({
        type: "GAME_STATE",
        sessionId: session.id,
        gameId: session.gameId,
        circuitId: circuit.id,
        gameLog: gameLog as GameLogEntry[],
        grid: gridForProof as any,
        merkleRoot: session.minesweeperSession.merkleRoot,
      });

      return {
        xp,
        status,
        isVictory,
        proofStatus: "Queued",
      };
    }),

  // -----------------------------------------------------------------------
  // GET GAME — Poll for game state / proof status
  // -----------------------------------------------------------------------
  getGame: publicProcedure
    .input(z.object({ gameId: z.string().uuid() }))
    .query(async ({ input }) => {
      const session = await prisma.gameSession.findUnique({
        where: { id: input.gameId },
        include: {
          minesweeperSession: true,
          proofs: {
            include: { verificationJob: true },
            orderBy: { createdAt: 'desc' },
            take: 1
          }
        },
      });

      if (!session || !session.minesweeperSession) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Game not found" });
      }

      const latestProof = session.proofs[0];
      const proofStatus = latestProof?.verificationJob?.verificationStatus || "Queued";

      return {
        id: session.id,
        merkleRoot: session.minesweeperSession.merkleRoot,
        status: session.status,
        xp: 0, 
        proofStatus,
        createdAt: session.createdAt,
      };
    }),
});
