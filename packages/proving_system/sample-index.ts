import { registerVk, generateProof, verifyProof } from "./prove";
import { CircuitKind } from "./type";
import { get_game_grid } from "./circuits";
import axios from "axios";

async function main() {
  try {
    // console.log(` ## Registering Verification Keys`);
    // await registerVk(CircuitKind.INIT_BOARD);
    // await registerVk(CircuitKind.GAME_STATE);

    console.log(` ## Session Start: Fetching Seed`);
    const { KURIER_URL, KURIER_API } = process.env;
    if (!KURIER_URL || !KURIER_API) {
      throw new Error("[ERR: Env] Missing environment variables");
    }

    console.log(` ## Fetching Seed\n`);
    const seed_response = await axios.post(
      `${KURIER_URL}/random-hash/${KURIER_API}`,
      {},
    );
    const seed = seed_response.data.hash;
    console.log(` ## Seed: ${seed}\n`);

    console.log(` ## Generating Game Grid\n`);
    const [grid, root] = await get_game_grid(seed.toString());
    console.log(` ## Root: ${root}`);

    const { proofHex, publicInputs } = await generateProof(
      CircuitKind.INIT_BOARD,
      {
        seed,
        merkle_root: root,
      },
    );
    console.log(` ## Public Inputs: ${publicInputs}`);

    await verifyProof(CircuitKind.INIT_BOARD, proofHex, publicInputs);
    console.log(` ## Proof Verified`);

    let indices: number[] = [2, 4, 6, 8, 10, 12];
    let values = [];
    if (!grid) {
      throw new Error("[ERR: Logic] Grid is empty");
    } else {
      for (let i = 0; i < indices.length; i++) {
        const index = indices[i];
        if (index === undefined) continue;
        const value = grid[index]!.value;
        values.push(value);
      }
    }
    console.log(` ## Logged Values: ${values}`);

    let log_indices: string[] = indices.map((i) => i.toString());
    let log_values: string[] = [...values];

    for (let i = 0; i < 71 - indices.length; i++) {
      log_indices.push("255");
      log_values.push("255");
    }

    console.log(` ## Logged Indices length: ${log_indices.length}`);
    console.log(` ## Logged Values length: ${log_values.length}`);

    const { proofHex: new_proofHex, publicInputs: new_publicInputs } =
      await generateProof(CircuitKind.GAME_STATE, {
        log_indices,
        log_values,
        grid,
        merkle_root: root,
      });
    console.log(` ## Public Inputs: ${new_publicInputs}`);

    await verifyProof(CircuitKind.GAME_STATE, new_proofHex, new_publicInputs);
    console.log(` ## Proof Verified`);
  } catch (error) {
    console.error(error);
  }
}

main();
