import { type CompiledCircuit, Noir } from "@noir-lang/noir_js";
import { UltraHonkBackend } from "@aztec/bb.js";
import { CircuitKind } from "./type";
import {
  extractAbiParameters,
  loadCircuitAbi,
  uint8ArrayToHex,
  validateAbiInput,
} from "./utils";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

console.log("[ZK Debug] __filename:", __filename);
console.log("[ZK Debug] __dirname:", __dirname);
console.log("[ZK Debug] process.cwd():", process.cwd());

// setting up Noir and UltraHonk Backend for specific circuit
export function setupProver(circuit_name: CircuitKind) {
  // Use path.resolve and __dirname to reliably find the circuit relative to this file
  const PATH_TO_CIRCUIT = path.resolve(
    __dirname,
    "circuits",
    "target",
    `${circuit_name}.json`,
  );


  console.log(`[ZK] Looking for circuit at: ${PATH_TO_CIRCUIT}`);

  if (!fs.existsSync(PATH_TO_CIRCUIT)) {
    throw new Error(`[ERR: Circuits] Circuit file not found at ${PATH_TO_CIRCUIT}`);
  }

  const circuit = JSON.parse(fs.readFileSync(PATH_TO_CIRCUIT, "utf8"));
  if (!circuit.bytecode) {
    throw new Error(`[ERR: Circuits] Circuit bytecode not found`);
  }

  console.log(`## Setting up Prover for ${circuit_name}`);
  const noir = new Noir(circuit as CompiledCircuit);
  const backend = new UltraHonkBackend(circuit.bytecode);
  return { noir, backend };
}

// generating and registering the circuit specific verification key with the zkVerify Kurier relayer
export async function registerVk(circuit_name: CircuitKind) {
  const { KURIER_URL, KURIER_API } = process.env;
  if (!KURIER_URL || !KURIER_API) {
    throw new Error("[ERR: Env] Missing environment variables");
  }

  const { backend } = setupProver(circuit_name);
  console.log(`## Generating Verification Key for ${circuit_name}`);
  const verification_key = await backend.getVerificationKey({ keccak: true });

  const vkey = uint8ArrayToHex(verification_key);
  const VK_HEX_PATH = path.join(
    "circuits",
    "target",
    `${circuit_name}_vk.hex`,
  );
  fs.writeFileSync(VK_HEX_PATH, vkey);
  if (!fs.existsSync(VK_HEX_PATH)) {
    throw new Error(
      "[ERR: Verification Key] Failed to write verification key hex file",
    );
  }

  const vk_payload = {
    proofType: "ultrahonk",
    proofOptions: {
      variant: "Plain",
    },
    vk: `${vkey}`,
  };

  console.log(`## Registering Verification Key at Kurier for ${circuit_name}`);
  const reg_vk_response = await axios.post(
    `${KURIER_URL}/register-vk/${KURIER_API}`,
    vk_payload,
  );

  const VK_HASH_PATH = path.join(
    "circuits",
    "target",
    `${circuit_name}_vkHash.json`,
  );
  fs.writeFileSync(VK_HASH_PATH, JSON.stringify(reg_vk_response.data));
  if (!fs.existsSync(VK_HASH_PATH)) {
    throw new Error(
      "[ERR: Verification Key] Failed to write verification key hash file",
    );
  }
}

// generating circuit specific ultrahonk proof with the given inputs
export async function generateProof(
  circuit_name: CircuitKind,
  inputs: Record<string, any>,
): Promise<{ proofHex: string; publicInputs: string[] }> {
  const { noir, backend } = setupProver(circuit_name);

  console.log(
    `## Extracting parameters and matching inputs for ${circuit_name}`,
  );
  const abi = loadCircuitAbi(circuit_name);
  validateAbiInput(inputs, abi);
  const params = extractAbiParameters(inputs, abi);
  console.log(`## Creating private witness for ${circuit_name}`);
  const { witness } = await noir.execute(params);

  console.log(`## Generating Proof for ${circuit_name}`);
  const proof_data = await backend.generateProof(witness, {
    keccak: true,
  });

  
  const PATH_TO_PROOF_HEX = path.join(
    "circuits",
    "target",
    `${circuit_name}_proof.hex`,
  );

  const PATH_TO_PUBLIC_INPUTS = path.join(
    "circuits",
    "target",
    `${circuit_name}_publicInputs.json`,
  );

  const proofHex = uint8ArrayToHex(proof_data.proof);

  fs.writeFileSync(PATH_TO_PROOF_HEX, proofHex); // TODO: store `proofHex` to db as TEXT
  if (!fs.existsSync(PATH_TO_PROOF_HEX)) {
    throw new Error("[ERR: Proof] Failed to write proof to file");
  }

  fs.writeFileSync(
    
    PATH_TO_PUBLIC_INPUTS,
    JSON.stringify(proof_data.publicInputs),
    "utf-8",
  );
  if (!fs.existsSync(PATH_TO_PUBLIC_INPUTS)) {
    throw new Error("[ERR: Proof] Failed to write public inputs to file");
  }

  console.log(`## Verifying Proof w/ BB.js for ${circuit_name}`);
  const is_valid = await backend.verifyProof(proof_data, {
    keccak: true,
  });
  if (!is_valid) {
    throw new Error("[ERR: Proof] Proof verification failed");
  }

  return {
    proofHex,
    publicInputs: proof_data.publicInputs.map((pi) =>
      pi.startsWith("0x") ? pi : `0x${pi}`,
    ),
  };
}

export async function verifyProof(
  circuit_name: CircuitKind,
  proofHex: string,
  formattedPublicInputs: string[],
) {
  const { KURIER_URL, KURIER_API } = process.env;
  if (!KURIER_URL || !KURIER_API) {
    throw new Error("[ERR: Env] Missing environment variables");
  }

  const VK_HASH_PATH = path.join(
    __dirname,
    "circuits",
    "target",
    `${circuit_name}_vkHash.json`,
  );
  if (!fs.existsSync(VK_HASH_PATH)) {
    console.log(
      `[WARN: Verification Key] VK hash not found for ${circuit_name}, registering new VK`,
    );
    await registerVk(circuit_name);
  }
  const vkey = JSON.parse(fs.readFileSync(VK_HASH_PATH, "utf8"));
  const vkHash = vkey.vkHash || vkey.meta.vkHash;
  if (!vkHash) {
    throw new Error("[ERR: ZKV] Verification key not found");
  }
  console.log(`## vkHash found for ${circuit_name}: ${vkHash}`);
  const proof_payload = {
    proofType: "ultrahonk",
    vkRegistered: true,
    chainId: 84532,
    proofOptions: {
      variant: "Plain",
    },
    proofData: {
      proof: `${proofHex}`,
      publicSignals: formattedPublicInputs,
      vk: vkHash as string,
    },
    submissionMode: "attestation",
  };

  
  const payloads_path = path.join(__dirname, "payloads_and_respones");
  if (!fs.existsSync(payloads_path)) {
    fs.mkdirSync(payloads_path, { recursive: true });
  }

  fs.writeFileSync(
    path.join(payloads_path, `${circuit_name}_proof_payload.json`),
    JSON.stringify(proof_payload),
  );

  console.log("## Submitting Proof to Kurier");
  const submit_response = await axios.post(
    `${KURIER_URL}/submit-proof/${KURIER_API}`,
    proof_payload,
  );

  console.log(
    `Proof response status code for ${circuit_name}:`,
    submit_response.status,
  );

  const path_to_submit_proof_response = path.join(
    "payloads_and_respones",
    `${circuit_name}_proof_response.json`,
  );

  fs.writeFileSync(
    path_to_submit_proof_response,
    JSON.stringify(submit_response.data),
  );

  console.log(
    `==> Submit Response:\n`,
    JSON.stringify(submit_response.data, null, 2),
  );
  if (submit_response.data.optimisticVerify !== "success") {
    throw new Error("[ERR: Proof Verification] Optimistic verification failed");
  }

  const jobId = submit_response.data.jobId; // TODO: store jobId to db as TEXT
  console.log(
    `## Proof submitted successfully for ${circuit_name}. Job ID: ${jobId}`,
  );

  while (true) {
    const job_status_response = await axios.get(
      `${KURIER_URL}/job-status/${KURIER_API}/${jobId}`,
    );
    if (job_status_response.data.status === "Aggregated") {
      console.log("##Job aggregated successfully");
      console.log(job_status_response.data);

      
      const aggregations_dir = path.join(__dirname, "aggregations");
      if (!fs.existsSync(aggregations_dir)) {
        fs.mkdirSync(aggregations_dir, { recursive: true });
      }

      const aggregation_path = path.join(
        aggregations_dir,
        `${job_status_response.data.aggregationId}.json`,
      );
      fs.writeFileSync(
        
        aggregation_path,
        JSON.stringify(job_status_response.data, null, 2),
      );
      console.log(`## Aggregation result saved to ${aggregation_path}`);
      break; // Exit loop after successful aggregation
    } else if (job_status_response.data.status === "Failed") {
      console.error("##Job failed:", job_status_response.data);
      throw new Error("[ERR: ZKV] Proof aggregation failed");
    } else {
      console.log("##Job status: ", job_status_response.data.status);
      console.log(`==> Waiting for job to be aggregated...`);
      await new Promise((resolve) => setTimeout(resolve, 20000)); // Wait for 20 seconds before checking again
    }
  }
}
