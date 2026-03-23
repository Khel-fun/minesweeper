// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {MinesweeperState} from "../src/MinesweeperState.sol";

/**
 * @title DeployMinesweeperState
 * @notice Deterministic deployment script for MinesweeperState.
 * @dev Usage:
 *      forge script script/MinesweeperState.s.sol:DeployMinesweeperState \
 *        --rpc-url <RPC_URL> \
 *        --private-key <DEPLOYER_PK> \
 *        --broadcast
 *
 *      Required environment variables:
 *        SERVER_SIGNER  — The backend's public key address (authorised signer).
 */
contract DeployMinesweeperState is Script {
    function run() external {
        address serverSigner = vm.envAddress("SERVER_SIGNER");

        vm.startBroadcast();

        MinesweeperState gameState = new MinesweeperState(
            serverSigner,
            msg.sender // deployer becomes owner
        );

        vm.stopBroadcast();

        console2.log("MinesweeperState deployed to:", address(gameState));
        console2.log("Server signer:", serverSigner);
        console2.log("Owner:", msg.sender);
    }
}
