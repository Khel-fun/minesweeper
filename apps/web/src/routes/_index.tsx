import { useState, useCallback, useEffect } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { trpc, trpcClient, queryClient } from "@/utils/trpc";
import GameBoard from "@/components/game-board";
import GameStatus from "@/components/game-status";
import { Button } from "@minesweeper/ui/components/button";
import type { Route } from "./+types/_index";

const MINE_VALUE = 9;
const SAFE_CELLS = 71;

interface GameLogEntry {
  index: number;
  value: number;
}

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Verifiable Minesweeper" },
    {
      name: "description",
      content: "A cryptographically verifiable Minesweeper game powered by Zero-Knowledge proofs",
    },
  ];
}

export default function Home() {
  // --- Game State ---
  const [gameId, setGameId] = useState<string | null>(null);
  const [merkleRoot, setMerkleRoot] = useState<string | null>(null);
  const [revealedCells, setRevealedCells] = useState<Map<number, number>>(new Map());
  const [flaggedCells, setFlaggedCells] = useState<Set<number>>(new Set());
  const [gameLog, setGameLog] = useState<GameLogEntry[]>([]);
  const [gameStatus, setGameStatus] = useState<"idle" | "playing" | "won" | "lost">("idle");
  const [xp, setXp] = useState(0);
  const [minePositions, setMinePositions] = useState<number[]>([]);
  const [proofStatus, setProofStatus] = useState<string | null>(null);

  // --- tRPC Mutations ---
  const startGameMutation = useMutation({
    mutationFn: () => trpcClient.game.startGame.mutate(),
    onSuccess: (data) => {
      setGameId(data.gameId);
      setMerkleRoot(data.merkleRoot);
      setRevealedCells(new Map());
      setFlaggedCells(new Set());
      setGameLog([]);
      setGameStatus("playing");
      setXp(0);
      setMinePositions([]);
      setProofStatus(null);
    },
  });

  const revealCellMutation = useMutation({
    mutationFn: (input: { gameId: string; index: number }) =>
      trpcClient.game.revealCell.mutate(input),
    onSuccess: (data) => {
      // Update revealed cells and game log
      setRevealedCells((prev) => {
        const next = new Map(prev);
        for (const cell of data.cells) {
          next.set(cell.index, cell.value);
        }
        return next;
      });

      // Add to game log — only for the initially clicked cell and its cascade
      setGameLog((prev) => {
        const existing = new Set(prev.map((e) => e.index));
        const newEntries = data.cells.filter((c) => !existing.has(c.index));
        return [...prev, ...newEntries];
      });

      if (data.gameOver) {
        if (data.isVictory) {
          setGameStatus("won");
        } else {
          setGameStatus("lost");
          // Collect mine positions from the revealed data
          setMinePositions(data.cells.filter((c) => c.value === MINE_VALUE).map((c) => c.index));
        }
      }
    },
  });

  const endGameMutation = useMutation({
    mutationFn: (input: { gameId: string; gameLog: GameLogEntry[] }) =>
      trpcClient.game.endGame.mutate(input),
    onSuccess: (data) => {
      setXp(data.xp);
      setProofStatus(data.proofStatus);
    },
  });

  // --- Compute running XP ---
  const runningXP = Array.from(revealedCells.values()).reduce((sum, value) => {
    if (value === 0) return sum + 10;
    if (value >= 1 && value <= 8) return sum + value;
    return sum;
  }, 0);

  // --- Check for victory ---
  useEffect(() => {
    const safeRevealed = Array.from(revealedCells.values()).filter((v) => v !== MINE_VALUE).length;
    if (gameStatus === "playing" && safeRevealed >= SAFE_CELLS) {
      setGameStatus("won");
    }
  }, [revealedCells, gameStatus]);

  // --- Submit game log on game over ---
  useEffect(() => {
    if ((gameStatus === "won" || gameStatus === "lost") && gameId && gameLog.length > 0) {
      endGameMutation.mutate({ gameId, gameLog });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gameStatus]);

  // --- Poll for proof status ---
  const gameQuery = useQuery({
    ...trpc.game.getGame.queryOptions({ gameId: gameId ?? "" }),
    enabled: !!gameId && proofStatus === "pending",
    refetchInterval: 5000,
  });

  useEffect(() => {
    if (gameQuery.data?.proofStatus && gameQuery.data.proofStatus !== proofStatus) {
      setProofStatus(gameQuery.data.proofStatus);
      if (gameQuery.data.xp > 0) {
        setXp(gameQuery.data.xp);
      }
    }
  }, [gameQuery.data, proofStatus]);

  // --- Handlers ---
  const handleCellClick = useCallback(
    (index: number) => {
      if (!gameId || gameStatus !== "playing") return;
      revealCellMutation.mutate({ gameId, index });
    },
    [gameId, gameStatus, revealCellMutation],
  );

  const handleCellRightClick = useCallback(
    (index: number) => {
      setFlaggedCells((prev) => {
        const next = new Set(prev);
        if (next.has(index)) {
          next.delete(index);
        } else {
          next.add(index);
        }
        return next;
      });
    },
    [],
  );

  const handleNewGame = useCallback(() => {
    startGameMutation.mutate();
  }, [startGameMutation]);

  return (
    <div className="game-page">
      <div className="game-container">
        {/* Header Section */}
        <div className="game-header">
          <h1 className="game-title" id="game-title">
            <span className="title-icon">💣</span>
            Minesweeper
            <span className="title-badge">ZK</span>
          </h1>
          <p className="game-subtitle">Cryptographically Verifiable Fairness</p>
        </div>

        {/* Controls */}
        <div className="game-controls">
          <Button
            id="new-game-btn"
            onClick={handleNewGame}
            disabled={startGameMutation.isPending}
            className="new-game-btn"
          >
            {startGameMutation.isPending ? "Creating Board..." : "New Game"}
          </Button>
        </div>

        {/* Merkle Root Display */}
        {merkleRoot && (
          <div className="merkle-display" id="merkle-root">
            <span className="merkle-label">🔐 Merkle Root</span>
            <code className="merkle-value">
              {merkleRoot.slice(0, 10)}...{merkleRoot.slice(-8)}
            </code>
          </div>
        )}

        {/* Status Bar */}
        <GameStatus
          gameId={gameId}
          status={gameStatus}
          xp={gameStatus === "won" || gameStatus === "lost" ? xp : runningXP}
          flagCount={flaggedCells.size}
          revealedCount={Array.from(revealedCells.values()).filter((v) => v !== MINE_VALUE).length}
          proofStatus={proofStatus}
        />

        {/* Game Board */}
        <GameBoard
          gameId={gameId}
          revealedCells={revealedCells}
          flaggedCells={flaggedCells}
          gameOver={gameStatus === "won" || gameStatus === "lost"}
          isVictory={gameStatus === "won"}
          onCellClick={handleCellClick}
          onCellRightClick={handleCellRightClick}
          minePositions={minePositions}
        />

        {/* Footer Info */}
        <div className="game-footer">
          <p>9×9 Grid • 10 Mines • ZK-Proven Fair Play</p>
        </div>
      </div>
    </div>
  );
}
