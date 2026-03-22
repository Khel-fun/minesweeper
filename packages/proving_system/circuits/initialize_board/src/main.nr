use assist::{
    assert_adjacency_constraint, assert_mine_count,
    build_merkle_tree, cell, get_grid, get_merkle_leaves, get_salts,
};

fn main(
    seed:        Field,      // private - the secret that determines mine placement
    merkle_root: pub Field,  // public  - the commitment the verifier checks against
) {
    let salts: [Field; 81] = get_salts(seed);
    let grid:  [cell; 81]  = get_grid(salts, seed);

    assert_mine_count(grid);
    assert_adjacency_constraint(grid);

    let merkle_leaves = get_merkle_leaves(grid);
    let merkle_tree   = build_merkle_tree(merkle_leaves);
    let computed_root = merkle_tree[0];

    assert(computed_root == merkle_root, "[ERR: InitBoard] merkle root mismatch");
}