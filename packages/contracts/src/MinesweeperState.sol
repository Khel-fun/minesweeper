// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title MinesweeperState
 * @notice On-chain settlement contract for Verifiable Minesweeper.
 * @dev Follows an Off-Chain Engine / On-Chain Settlement model.
 *      The backend signs game results with ECDSA; players broadcast
 *      the signed payload to mint XP and update stats on-chain.
 *      The contract itself never performs ZK verification — that
 *      happens off-chain via zkVerify / Kurier.
 */
contract MinesweeperState is Ownable {
    using ECDSA for bytes32;
    using MessageHashUtils for bytes32;

    // ──────────────────── Types ────────────────────

    struct PlayerStats {
        uint256 totalXP;
        uint256 gamesPlayed;
        uint256 gamesWon;
    }

    // ──────────────────── State ────────────────────

    /// @notice The address whose ECDSA signatures are treated as authoritative.
    address public serverSigner;

    /// @notice Cumulative stats per player wallet.
    mapping(address => PlayerStats) public players;

    /// @notice Tracks consumed Game IDs for replay protection.
    mapping(bytes32 => bool) public processedGames;

    // ──────────────────── Events ───────────────────

    /// @notice Emitted when a game result is successfully published.
    event GameResultPublished(
        address indexed player,
        bytes32 indexed gameId,
        uint256 xpEarned,
        bool won
    );

    /// @notice Emitted when the authorised server signer is rotated.
    event ServerSignerUpdated(address indexed oldSigner, address indexed newSigner);

    // ──────────────────── Errors ───────────────────

    error GameAlreadyProcessed(bytes32 gameId);
    error InvalidServerSignature();
    error ZeroAddressSigner();

    // ──────────────────── Constructor ──────────────

    /**
     * @param _serverSigner Initial authorised signer address (backend public key).
     * @param _owner        The administrative owner (ideally a multisig / hardware wallet).
     */
    constructor(address _serverSigner, address _owner) Ownable(_owner) {
        if (_serverSigner == address(0)) revert ZeroAddressSigner();
        serverSigner = _serverSigner;
    }

    // ──────────────── External Functions ───────────

    /**
     * @notice Publish a verified game result on-chain.
     * @dev    The caller (msg.sender) MUST be the player whose address was
     *         included in the server's signed payload. This prevents front-running.
     * @param gameId    Unique identifier for the completed game.
     * @param xpEarned  XP awarded by the backend for this game.
     * @param won       Whether the player won the game.
     * @param signature ECDSA signature produced by the backend over
     *                  `keccak256(abi.encodePacked(gameId, msg.sender, xpEarned, won))`.
     */
    function publishResult(
        bytes32 gameId,
        uint256 xpEarned,
        bool won,
        bytes calldata signature
    ) external {
        // 1. Replay protection
        if (processedGames[gameId]) revert GameAlreadyProcessed(gameId);

        // 2. Reconstruct the hash the server signed
        bytes32 dataHash = keccak256(
            abi.encodePacked(gameId, msg.sender, xpEarned, won)
        );
        bytes32 ethSignedHash = dataHash.toEthSignedMessageHash();

        // 3. Recover signer and validate
        address recovered = ethSignedHash.recover(signature);
        if (recovered != serverSigner) revert InvalidServerSignature();

        // 4. Mark game as consumed
        processedGames[gameId] = true;

        // 5. Update player stats
        PlayerStats storage stats = players[msg.sender];
        stats.totalXP += xpEarned;
        stats.gamesPlayed += 1;
        if (won) {
            stats.gamesWon += 1;
        }

        // 6. Emit event for indexers / leaderboards
        emit GameResultPublished(msg.sender, gameId, xpEarned, won);
    }

    // ──────────────── Admin Functions ──────────────

    /**
     * @notice Rotate the authorised server signer (key-compromise recovery).
     * @param newSigner The new backend public key address.
     */
    function setServerSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddressSigner();
        address oldSigner = serverSigner;
        serverSigner = newSigner;
        emit ServerSignerUpdated(oldSigner, newSigner);
    }

    // ──────────────── View Functions ───────────────

    /**
     * @notice Retrieve cumulative stats for a player.
     * @param player Wallet address to query.
     * @return totalXP      Cumulative XP.
     * @return gamesPlayed  Total games published.
     * @return gamesWon     Total victories.
     */
    function getPlayerStats(address player)
        external
        view
        returns (uint256 totalXP, uint256 gamesPlayed, uint256 gamesWon)
    {
        PlayerStats storage s = players[player];
        return (s.totalXP, s.gamesPlayed, s.gamesWon);
    }
}
