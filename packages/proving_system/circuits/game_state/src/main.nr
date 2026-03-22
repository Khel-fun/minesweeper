use assist::{
    assert_adjacency_constraint, assert_mine_count, build_merkle_tree, cell, get_merkle_leaves,
    MINE_VALUE, NEIGHBOR_SENTINEL,
};

fn main(
    log_indices: [Field; 71],
    log_values: [Field; 71],
    grid: [cell; 81],
    merkle_root: pub Field,
) {
    // --- 1. Assert the grid is internally valid ---
    assert_mine_count(grid);
    assert_adjacency_constraint(grid);

    // --- 2. Bind the private grid to the public Merkle commitment ---
    let leaf_hashes = get_merkle_leaves(grid);
    let tree = build_merkle_tree(leaf_hashes);
    let computed_root = tree[0];

    assert(computed_root == merkle_root, "[ERR: GameState] merkle root mismatch");

    // --- 3. Validate log entries ---
    for i in 0..71 {
        let idx: u8 = log_indices[i] as u8;
        let logged_v: u8 = log_values[i] as u8;

        // is_real  : 1 if this slot carries a genuine reveal, 0 if filler (255)
        // in_range : 1 if idx is a valid grid address [0, 80]
        // Both expressed as Field for the selector pattern below.
        let is_real: Field = if idx != NEIGHBOR_SENTINEL { 1 } else { 0 };
        let in_range: Field = if idx as u32 <= 80 { 1 } else { 0 };

        // Safe index - clamp to 0 for sentinel/out-of-range entries so the
        // array access below never goes out of bounds regardless of idx value.
        // The selector constraints below ensure the clamped read has no effect
        // when is_real is 0.
        let safe_idx: u32 = if (idx != NEIGHBOR_SENTINEL) & (idx as u32 <= 80) {
            idx as u32
        } else {
            0
        };

        let grid_value: u8 = grid[safe_idx].value;
        let values_match: Field = if logged_v == grid_value { 1 } else { 0 };

        // Selector pattern - single multiplication gate per constraint,
        // no conditional asserts that could behave differently across
        // prover and verifier execution paths.
        //
        // Enforce: real entry must be in range [0, 80]
        assert(
            is_real * (1 - in_range) == 0,
            "[ERR: GameState] log index out of valid range [0, 80]",
        );
        // Enforce: real entry and logged value must match committed grid cell
        assert(
            is_real * (1 - values_match) == 0,
            "[ERR: GameState] logged value does not match committed grid cell",
        );
    }
}
