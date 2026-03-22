use dep::std;

global GRID_COUNT: u8 = 81;
global PADDED_LEAVES: u32 = 128;
global TREE_SIZE: u32 = 255;
global LEAF_OFFSET: u32 = 127;

// Domain separators - keep hash chains for mines and salts
// cryptographically distinct even though input arities already differ.
global MINE_DOMAIN: Field = 11111;
global SALT_DOMAIN: Field = 23456;

// Dummy cell constants - single source of truth used by get_merkle_leaves
// and any binary that needs to reproduce the same dummy leaf hash.
global DUMMY_INDEX: u8 = 255;
global DUMMY_VALUE: u8 = 255;
global DUMMY_SALT: Field = 255;

// Sentinel for mine cells and out-of-bounds neighbors.
global MINE_VALUE: u8 = 9;
global NEIGHBOR_SENTINEL: u8 = 255;

pub struct cell {
    index: u8,
    value: u8,
    salt: Field,
}

// ---------------------------------------------------------------------------
// Salt derivation
// ---------------------------------------------------------------------------
pub fn get_salts(seed: Field) -> [Field; 81] {
    let mut salts: [Field; 81] = [0; 81];
    for i in 0..81 {
        salts[i] = std::hash::pedersen_hash([seed, SALT_DOMAIN, i as Field]);
    }
    salts
}

// ---------------------------------------------------------------------------
// Mine index selection
// ---------------------------------------------------------------------------
pub fn get_mine_indices(seed: Field) -> [u8; 10] {
    let mut chosen: [u8; 10] = [0; 10];
    let mut chosen_count: u8 = 0;

    for nonce in 0..30 {
        let still_needed: bool = chosen_count < 10;

        // Explicit MINE_DOMAIN prefix - domain-separates this chain from get_salts.
        let hash = std::hash::pedersen_hash([seed, MINE_DOMAIN, nonce as Field]);
        let candidate = (hash as u64 % 81) as u8;

        // Flattened duplicate check - single boolean accumulation,
        let mut is_duplicate: bool = false;
        for j in 0..10 {
            let slot_active: bool = (j as u8) < chosen_count;
            let matches: bool = chosen[j] == candidate;
            is_duplicate = is_duplicate | (slot_active & matches);
        }

        if still_needed & !is_duplicate {
            chosen[chosen_count as u32] = candidate;
            chosen_count += 1;
        }
    }

    assert(chosen_count == 10, "[ERR: Mines] failed to derive 10 distinct mine indices");
    chosen
}

// ---------------------------------------------------------------------------
// Neighbor resolution
// ---------------------------------------------------------------------------
pub fn get_cell_neighbors(index: u8) -> [u8; 8] {
    let mut neighbors: [u8; 8] = [NEIGHBOR_SENTINEL; 8];

    let row = (index / 9) as i8;
    let col = (index % 9) as i8;

    // TL,   T,  TR,   L,   R,  BL,   B,  BR
    let d_rows: [i8; 8] = [-1, -1, -1, 0, 0, 1, 1, 1];
    let d_cols: [i8; 8] = [-1, 0, 1, -1, 1, -1, 0, 1];

    for i in 0..8 {
        let new_row: i8 = row + d_rows[i];
        let new_col: i8 = col + d_cols[i];
        if (new_row >= 0) & (new_row < 9) & (new_col >= 0) & (new_col < 9) {
            neighbors[i] = (new_row * 9 + new_col) as u8;
        }
    }
    neighbors
}

// ---------------------------------------------------------------------------
// Grid construction
// ---------------------------------------------------------------------------
pub fn get_grid(salts: [Field; 81], seed: Field) -> [cell; 81] {
    let mine_indices: [u8; 10] = get_mine_indices(seed);

    let mut is_mine: [bool; 81] = [false; 81];
    for m in 0..10 {
        is_mine[mine_indices[m] as u32] = true;
    }

    let mut grid: [cell; 81] = [cell { index: 0, value: 0, salt: 0 }; 81];

    for i in 0..81 {
        let neighbors: [u8; 8] = get_cell_neighbors(i as u8);
        let mut mine_count: u8 = 0;

        for n in 0..8 {
            let neighbor_idx = neighbors[n];
            if neighbor_idx != NEIGHBOR_SENTINEL {
                if is_mine[neighbor_idx as u32] {
                    mine_count += 1;
                }
            }
        }

        // is_mine_field * (MINE_VALUE - mine_count) shifts the value to 9 for mines,
        // and contributes 0 for non-mines leaving mine_count intact.
        let is_mine_field: u8 = if is_mine[i] { 1 } else { 0 };
        let value: u8 = mine_count + is_mine_field * (MINE_VALUE - mine_count);

        grid[i] = cell { index: i as u8, value, salt: salts[i] };
    }
    grid
}

// ---------------------------------------------------------------------------
// Grid constraints
// ---------------------------------------------------------------------------
pub fn assert_mine_count(grid: [cell; 81]) {
    let mut count: u8 = 0;
    for i in 0..81 {
        if grid[i].value == MINE_VALUE {
            count += 1;
        }
    }
    assert(count == 10, "[ERR: Grid] must contain exactly 10 mines");
}

pub fn assert_adjacency_constraint(grid: [cell; 81]) {
    for i in 0..81 {
        let is_mine: Field = if grid[i].value == MINE_VALUE { 1 } else { 0 };

        let neighbors: [u8; 8] = get_cell_neighbors(i as u8);
        let mut s: Field = 0;

        for n in 0..8 {
            let neighbor_idx = neighbors[n];
            if neighbor_idx != NEIGHBOR_SENTINEL {
                let neighbor_is_mine: Field = if grid[neighbor_idx as u32].value == MINE_VALUE {
                    1
                } else {
                    0
                };
                s += neighbor_is_mine;
            }
        }

        let value: Field = grid[i].value as Field;
        assert((1 - is_mine) * (value - s) == 0, "[ERR: Grid] adjacency constraint violated");
    }
}

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------
pub fn hash_leaf_node(index: u8, value: u8, salt: Field) -> Field {
    std::hash::pedersen_hash([index as Field, value as Field, salt])
}

pub fn hash_sibling_nodes(left: Field, right: Field) -> Field {
    std::hash::pedersen_hash([left, right])
}

// ---------------------------------------------------------------------------
// Merkle tree
// ---------------------------------------------------------------------------
pub fn get_merkle_leaves(grid: [cell; 81]) -> [Field; 128] {
    let mut leaves: [Field; 128] = [0; 128];

    for i in 0..81 {
        leaves[i] = hash_leaf_node(grid[i].index, grid[i].value, grid[i].salt);
    }

    // Precompute dummy hash once
    let dummy_hash = hash_leaf_node(DUMMY_INDEX, DUMMY_VALUE, DUMMY_SALT);
    for i in 81..128 {
        leaves[i] = dummy_hash;
    }

    leaves
}

pub fn build_merkle_tree(leaf_hashes: [Field; 128]) -> [Field; 255] {
    let mut tree: [Field; 255] = [0; 255];

    for i in 0..128 {
        tree[LEAF_OFFSET + i] = leaf_hashes[i];
    }

    for step in 0..127 {
        let i = 126 - step;
        let left = tree[2 * i + 1];
        let right = tree[2 * i + 2];
        tree[i] = hash_sibling_nodes(left, right);
    }

    tree
}

// ---------------------------------------------------------------------------
// Off-chain oracle - unconstrained, used only by the TypeScript frontend
// to derive the grid and root.
// Constraints are enforced inside each binary's main circuit
// ---------------------------------------------------------------------------
#[export]
pub unconstrained fn get_game_grid(seed: Field) -> ([cell; 81], Field) {
    let salts = get_salts(seed);
    let grid = get_grid(salts, seed);

    let merkle_leaves = get_merkle_leaves(grid);
    let merkle_tree = build_merkle_tree(merkle_leaves);

    (grid, merkle_tree[0])
}
