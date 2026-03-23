import { generateProof, verifyProof } from "@minesweeper/proving_system/prove";
import { CircuitKind } from "@minesweeper/proving_system/type";
import type { cell } from "@minesweeper/proving_system/circuits";
import { padGameLog, type GameLogEntry } from "./game";

// ---------------------------------------------------------------------------
// INIT_BOARD proof — proves the board was generated correctly
// ---------------------------------------------------------------------------
export async function generateInitBoardProof(
  seed: string,
  merkleRoot: string,
) {
  console.log(`[ZK] Generating INIT_BOARD proof...`);
  const { proofHex, publicInputs } = await generateProof(
    CircuitKind.INIT_BOARD,
    { seed, merkle_root: merkleRoot },
  );
  console.log(`[ZK] INIT_BOARD proof generated. Public inputs: ${publicInputs}`);
  return { proofHex, publicInputs };
}

// ---------------------------------------------------------------------------
// GAME_STATE proof — proves the game was played fairly
// ---------------------------------------------------------------------------
export async function generateGameStateProof(
  gameLog: GameLogEntry[],
  grid: cell[],
  merkleRoot: string,
) {
  const { logIndices, logValues } = padGameLog(gameLog);

  console.log(`[ZK] Generating GAME_STATE proof (${gameLog.length} moves)...`);
  const { proofHex, publicInputs } = await generateProof(
    CircuitKind.GAME_STATE,
    {
      log_indices: logIndices,
      log_values: logValues,
      grid,
      merkle_root: merkleRoot,
    },
  );
  console.log(`[ZK] GAME_STATE proof generated. Public inputs: ${publicInputs}`);
  return { proofHex, publicInputs };
}

// ---------------------------------------------------------------------------
// Submit proof to zkVerify Kurier for decentralized attestation
// ---------------------------------------------------------------------------
export async function submitProofToKurier(
  circuitKind: CircuitKind,
  proofHex: string,
  publicInputs: string[],
) {
  console.log(`[ZK] Submitting ${circuitKind} proof to Kurier...`);
  await verifyProof(circuitKind, proofHex, publicInputs);
  console.log(`[ZK] ${circuitKind} proof submitted to Kurier successfully.`);
}
