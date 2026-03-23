// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {MinesweeperState} from "../src/MinesweeperState.sol";

/**
 * @title MinesweeperStateTest
 * @notice Comprehensive test suite for MinesweeperState including unit, security, and fuzz tests.
 */
contract MinesweeperStateTest is Test {
    MinesweeperState public state;

    // Server signer key-pair (deterministic for testing)
    uint256 internal constant SERVER_PK = 0xA11CE;
    address internal serverAddr;

    // Players
    address internal player1 = makeAddr("player1");
    address internal player2 = makeAddr("player2");

    // Contract owner
    address internal owner = makeAddr("owner");

    // ─────────────────── Helpers ───────────────────

    function setUp() public {
        serverAddr = vm.addr(SERVER_PK);
        state = new MinesweeperState(serverAddr, owner);
    }

    /// @dev Signs a game-result payload with the server's private key.
    function _signResult(
        bytes32 gameId,
        address player,
        uint256 xpEarned,
        bool won
    ) internal pure returns (bytes memory) {
        bytes32 dataHash = keccak256(abi.encodePacked(gameId, player, xpEarned, won));
        bytes32 ethSignedHash = _toEthSignedMessageHash(dataHash);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SERVER_PK, ethSignedHash);
        return abi.encodePacked(r, s, v);
    }

    /// @dev Mirrors MessageHashUtils.toEthSignedMessageHash.
    function _toEthSignedMessageHash(bytes32 hash) internal pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", hash));
    }

    // ══════════════════════════════════════════════
    //                UNIT TESTS
    // ══════════════════════════════════════════════

    function test_Constructor_SetsState() public view {
        assertEq(state.serverSigner(), serverAddr);
        assertEq(state.owner(), owner);
    }

    function test_Constructor_RevertsOnZeroSigner() public {
        vm.expectRevert(MinesweeperState.ZeroAddressSigner.selector);
        new MinesweeperState(address(0), owner);
    }

    function test_PublishResult_HappyPath() public {
        bytes32 gameId = keccak256("game-1");
        uint256 xp = 500;
        bool won = true;
        bytes memory sig = _signResult(gameId, player1, xp, won);

        vm.prank(player1);
        vm.expectEmit(true, true, false, true);
        emit MinesweeperState.GameResultPublished(player1, gameId, xp, won);
        state.publishResult(gameId, xp, won, sig);

        // Verify stats
        (uint256 totalXP, uint256 gamesPlayed, uint256 gamesWon) = state.getPlayerStats(player1);
        assertEq(totalXP, 500);
        assertEq(gamesPlayed, 1);
        assertEq(gamesWon, 1);

        // Verify game marked as processed
        assertTrue(state.processedGames(gameId));
    }

    function test_PublishResult_Loss() public {
        bytes32 gameId = keccak256("game-loss");
        uint256 xp = 10;
        bool won = false;
        bytes memory sig = _signResult(gameId, player1, xp, won);

        vm.prank(player1);
        state.publishResult(gameId, xp, won, sig);

        (uint256 totalXP, uint256 gamesPlayed, uint256 gamesWon) = state.getPlayerStats(player1);
        assertEq(totalXP, 10);
        assertEq(gamesPlayed, 1);
        assertEq(gamesWon, 0);
    }

    function test_PublishResult_CumulativeStats() public {
        // Game 1: win
        bytes32 gid1 = keccak256("g1");
        bytes memory sig1 = _signResult(gid1, player1, 100, true);
        vm.prank(player1);
        state.publishResult(gid1, 100, true, sig1);

        // Game 2: loss
        bytes32 gid2 = keccak256("g2");
        bytes memory sig2 = _signResult(gid2, player1, 20, false);
        vm.prank(player1);
        state.publishResult(gid2, 20, false, sig2);

        // Game 3: win
        bytes32 gid3 = keccak256("g3");
        bytes memory sig3 = _signResult(gid3, player1, 300, true);
        vm.prank(player1);
        state.publishResult(gid3, 300, true, sig3);

        (uint256 totalXP, uint256 gamesPlayed, uint256 gamesWon) = state.getPlayerStats(player1);
        assertEq(totalXP, 420);
        assertEq(gamesPlayed, 3);
        assertEq(gamesWon, 2);
    }

    function test_PublishResult_MultiplePlayersIndependent() public {
        bytes32 gid1 = keccak256("p1-game");
        bytes memory sig1 = _signResult(gid1, player1, 50, true);
        vm.prank(player1);
        state.publishResult(gid1, 50, true, sig1);

        bytes32 gid2 = keccak256("p2-game");
        bytes memory sig2 = _signResult(gid2, player2, 75, false);
        vm.prank(player2);
        state.publishResult(gid2, 75, false, sig2);

        (uint256 xp1, uint256 gp1, uint256 gw1) = state.getPlayerStats(player1);
        (uint256 xp2, uint256 gp2, uint256 gw2) = state.getPlayerStats(player2);

        assertEq(xp1, 50);
        assertEq(gp1, 1);
        assertEq(gw1, 1);
        assertEq(xp2, 75);
        assertEq(gp2, 1);
        assertEq(gw2, 0);
    }

    // ══════════════════════════════════════════════
    //              SECURITY TESTS
    // ══════════════════════════════════════════════

    function test_ReplayProtection_RevertsOnDuplicateGameId() public {
        bytes32 gameId = keccak256("unique-game");
        bytes memory sig = _signResult(gameId, player1, 100, true);

        vm.prank(player1);
        state.publishResult(gameId, 100, true, sig);

        // Second submission with the same gameId must revert
        vm.prank(player1);
        vm.expectRevert(abi.encodeWithSelector(MinesweeperState.GameAlreadyProcessed.selector, gameId));
        state.publishResult(gameId, 100, true, sig);
    }

    function test_FrontRunning_RevertsWhenWrongSender() public {
        bytes32 gameId = keccak256("victim-game");
        bytes memory sig = _signResult(gameId, player1, 500, true);

        // Attacker tries to submit player1's signature
        vm.prank(player2);
        vm.expectRevert(MinesweeperState.InvalidServerSignature.selector);
        state.publishResult(gameId, 500, true, sig);
    }

    function test_PayloadTampering_AlteredXP() public {
        bytes32 gameId = keccak256("tamper-xp");
        // Server signs for 10 XP
        bytes memory sig = _signResult(gameId, player1, 10, false);

        // Player submits with 10000 XP
        vm.prank(player1);
        vm.expectRevert(MinesweeperState.InvalidServerSignature.selector);
        state.publishResult(gameId, 10_000, false, sig);
    }

    function test_PayloadTampering_AlteredVictory() public {
        bytes32 gameId = keccak256("tamper-victory");
        // Server signs a loss
        bytes memory sig = _signResult(gameId, player1, 10, false);

        // Player flips `won` to true
        vm.prank(player1);
        vm.expectRevert(MinesweeperState.InvalidServerSignature.selector);
        state.publishResult(gameId, 10, true, sig);
    }

    function test_InvalidSignature_EmptyBytes() public {
        bytes32 gameId = keccak256("empty-sig");

        vm.prank(player1);
        vm.expectRevert(); // ECDSA library reverts on invalid length
        state.publishResult(gameId, 100, true, "");
    }

    function test_InvalidSignature_WrongLength() public {
        bytes32 gameId = keccak256("short-sig");

        vm.prank(player1);
        vm.expectRevert(); // ECDSA library reverts on invalid length
        state.publishResult(gameId, 100, true, hex"deadbeef");
    }

    // ──────────────── Admin Tests ─────────────────

    function test_SetServerSigner_OnlyOwner() public {
        address newSigner = makeAddr("newSigner");

        // Non-owner cannot call
        vm.prank(player1);
        vm.expectRevert();
        state.setServerSigner(newSigner);

        // Owner can call
        vm.prank(owner);
        vm.expectEmit(true, true, false, false);
        emit MinesweeperState.ServerSignerUpdated(serverAddr, newSigner);
        state.setServerSigner(newSigner);

        assertEq(state.serverSigner(), newSigner);
    }

    function test_SetServerSigner_RevertsOnZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert(MinesweeperState.ZeroAddressSigner.selector);
        state.setServerSigner(address(0));
    }

    function test_SetServerSigner_OldSignerInvalidated() public {
        // Sign with old key
        bytes32 gameId = keccak256("pre-rotation");
        bytes memory sig = _signResult(gameId, player1, 100, true);

        // Rotate signer
        uint256 newPk = 0xB0B;
        address newAddr = vm.addr(newPk);
        vm.prank(owner);
        state.setServerSigner(newAddr);

        // Old signature no longer valid
        vm.prank(player1);
        vm.expectRevert(MinesweeperState.InvalidServerSignature.selector);
        state.publishResult(gameId, 100, true, sig);
    }

    // ══════════════════════════════════════════════
    //                FUZZ TESTS
    // ══════════════════════════════════════════════

    /// @notice Random bytes should never pass as a valid signature.
    function testFuzz_RejectMalformedSignature(bytes memory sig) public {
        // Skip if sig is accidentally 65 bytes and could theoretically be valid
        // (astronomically unlikely, but we skip to avoid false positives)
        vm.assume(sig.length != 65 || sig.length == 65);

        bytes32 gameId = keccak256("fuzz-malformed");

        vm.prank(player1);
        // Must revert — either ECDSA length check or signer mismatch
        try state.publishResult(gameId, 100, true, sig) {
            // If it didn't revert, the fuzz accidentally produced a valid sig
            // for serverSigner over this exact payload. This is astronomically
            // improbable and should never happen.
            revert("Fuzz produced a valid signature - should be impossible");
        } catch {
            // Expected: reverted
        }
    }

    /// @notice Fuzzing XP and won values with a signature for different values must revert.
    function testFuzz_RejectAlteredPayload(uint256 fuzzedXP, bool fuzzedWon) public {
        bytes32 gameId = keccak256("fuzz-payload");
        uint256 realXP = 42;
        bool realWon = true;

        // Only test when fuzzer provides different values
        vm.assume(fuzzedXP != realXP || fuzzedWon != realWon);

        bytes memory sig = _signResult(gameId, player1, realXP, realWon);

        vm.prank(player1);
        vm.expectRevert(MinesweeperState.InvalidServerSignature.selector);
        state.publishResult(gameId, fuzzedXP, fuzzedWon, sig);
    }

    /// @notice Any sender address ≠ intended player must fail signature verification.
    function testFuzz_RejectWrongSender(address attacker) public {
        vm.assume(attacker != player1);
        vm.assume(attacker != address(0));

        bytes32 gameId = keccak256("fuzz-sender");
        bytes memory sig = _signResult(gameId, player1, 200, true);

        vm.prank(attacker);
        vm.expectRevert(MinesweeperState.InvalidServerSignature.selector);
        state.publishResult(gameId, 200, true, sig);
    }

    /// @notice Fuzzing gameId — only the exact gameId used in signing should work.
    function testFuzz_RejectWrongGameId(bytes32 wrongGameId) public {
        bytes32 correctGameId = keccak256("fuzz-gameid");
        vm.assume(wrongGameId != correctGameId);

        bytes memory sig = _signResult(correctGameId, player1, 100, true);

        vm.prank(player1);
        vm.expectRevert(MinesweeperState.InvalidServerSignature.selector);
        state.publishResult(wrongGameId, 100, true, sig);
    }
}
