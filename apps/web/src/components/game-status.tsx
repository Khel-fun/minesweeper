import { useState, useEffect, useRef } from "react";

interface GameStatusProps {
  gameId: string | null;
  status: "idle" | "playing" | "won" | "lost";
  xp: number;
  flagCount: number;
  revealedCount: number;
  proofStatus?: string | null;
}

export default function GameStatus({
  gameId,
  status,
  xp,
  flagCount,
  revealedCount,
  proofStatus,
}: GameStatusProps) {
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (status === "playing") {
      setElapsed(0);
      timerRef.current = setInterval(() => {
        setElapsed((prev) => prev + 1);
      }, 1000);
    } else {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    }
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [status]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  const minesRemaining = 10 - flagCount;

  const getStatusBadge = () => {
    switch (status) {
      case "idle":
        return { text: "Ready", class: "badge-idle" };
      case "playing":
        return { text: "In Progress", class: "badge-playing" };
      case "won":
        return { text: "Victory!", class: "badge-won" };
      case "lost":
        return { text: "Defeated", class: "badge-lost" };
    }
  };

  const getProofBadge = () => {
    if (!proofStatus) return null;
    switch (proofStatus) {
      case "pending":
        return { text: "⏳ Generating Proof...", class: "proof-pending" };
      case "generated":
        return { text: "📡 Submitting to zkVerify...", class: "proof-generated" };
      case "verified":
        return { text: "✅ Verified On-Chain", class: "proof-verified" };
      case "failed":
        return { text: "❌ Verification Failed", class: "proof-failed" };
      default:
        return null;
    }
  };

  const badge = getStatusBadge();
  const proofBadge = getProofBadge();

  return (
    <div className="status-bar">
      <div className="status-row">
        {/* Mine Counter */}
        <div className="status-item" id="mine-counter">
          <span className="status-icon">💣</span>
          <span className="status-value">{minesRemaining}</span>
        </div>

        {/* Status Badge */}
        <div className={`status-badge ${badge.class}`} id="game-status">
          {badge.text}
        </div>

        {/* Timer */}
        <div className="status-item" id="game-timer">
          <span className="status-icon">⏱️</span>
          <span className="status-value font-mono">{formatTime(elapsed)}</span>
        </div>
      </div>

      <div className="status-row">
        {/* XP Counter */}
        <div className="status-item" id="xp-counter">
          <span className="status-icon">⭐</span>
          <span className="status-value">{xp} XP</span>
        </div>

        {/* Cells Revealed */}
        <div className="status-item" id="cells-revealed">
          <span className="status-icon">🔍</span>
          <span className="status-value">{revealedCount}/71</span>
        </div>
      </div>

      {/* Proof Status */}
      {proofBadge && (
        <div className={`proof-badge ${proofBadge.class}`} id="proof-status">
          {proofBadge.text}
        </div>
      )}
    </div>
  );
}
