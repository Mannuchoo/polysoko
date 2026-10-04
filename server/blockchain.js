import dotenv from 'dotenv';
import 'dotenv/config';
import { ethers } from 'ethers';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, './.env') });
console.log("Checking .env load:", process.env.SOKO_CONTRACT_ADDRESS ? "✅ Loaded" : "❌ Still Missing");

// 1. Setup Environment Variables
const RPC_URL = process.env.AMOY_RPC_URL || "https://rpc-amoy.polygon.technology";
const CONTRACT_ADDRESS = process.env.SOKO_CONTRACT_ADDRESS;

// Use HOT_WALLET_PRIVATE_KEY as the source of truth
let rawKey = process.env.HOT_WALLET_PRIVATE_KEY || process.env.PRIVATE_KEY;

// 2. Automatically fix the MetaMask "No 0x" issue & trim spaces
if (rawKey) {
    rawKey = rawKey.trim();
    if (!rawKey.startsWith('0x')) {
        rawKey = '0x' + rawKey;
    }
}

// 3. Setup Connection
const JsonRpcProvider = ethers.JsonRpcProvider || ethers.providers?.JsonRpcProvider;
const isAddress = ethers.isAddress || ethers.utils?.isAddress;
const formatUnits = ethers.formatUnits || ethers.utils?.formatUnits;
const parseUnits = ethers.parseUnits || ethers.utils?.parseUnits;
const provider = new JsonRpcProvider(RPC_URL);

// 4. Initialize Admin Wallet safely
let adminWallet;
try {
    if (!rawKey || rawKey.length < 60) {
        throw new Error("Private Key is missing or invalid in .env");
    }
    adminWallet = new ethers.Wallet(rawKey, provider);
    console.log("✅ Blockchain Wallet Loaded:", adminWallet.address);
} catch (error) {
    console.error("❌ BLOCKCHAIN ERROR:", error.message);
    // Create a random wallet just so the server doesn't crash, 
    // though transactions will fail until the .env is fixed.
    adminWallet = ethers.Wallet.createRandom().connect(provider);
}

// 5. ERC-20 ABI
const SOKO_ABI = [
    "function name() view returns (string)",
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "function balanceOf(address owner) view returns (uint256)",
    "function transfer(address to, uint256 amount) returns (bool)",
    "event Transfer(address indexed from, address indexed to, uint256 amount)"
];

// 6. Create Contract Instance
// `new ethers.Contract(...)` throws synchronously when the address is missing or
// malformed. Because blockchain.js is imported at the top of server.js, that throw
// used to abort the process during module evaluation — before the HTTP server ever
// bound a port — which surfaced on Railway as "Application failed to respond".
// A placeholder zero address keeps the module importable; blockchain calls then
// fail loudly at call time instead of taking the whole API offline at boot.
const EFFECTIVE_CONTRACT_ADDRESS = (CONTRACT_ADDRESS && isAddress(CONTRACT_ADDRESS))
    ? CONTRACT_ADDRESS
    : '0x0000000000000000000000000000000000000000';

if (CONTRACT_ADDRESS && !isAddress(CONTRACT_ADDRESS)) {
    console.error('⚠️  SOKO_CONTRACT_ADDRESS is not a valid address; on-chain transfers are disabled until it is fixed.');
} else if (!CONTRACT_ADDRESS) {
    console.error('⚠️  SOKO_CONTRACT_ADDRESS is not set; on-chain transfers are disabled until it is configured.');
}

let sokoContract = null;
try {
    sokoContract = new ethers.Contract(EFFECTIVE_CONTRACT_ADDRESS, SOKO_ABI, adminWallet);
} catch (error) {
    console.error('⚠️  Failed to initialise SOKO contract:', error.message);
}

/**
 * EXPORTED FUNCTIONS
 */

export const getSokoBalance = async (address) => {
    try {
        if (!sokoContract) return "0";
        if (!isAddress(address)) return "0";
        const balance = await sokoContract.balanceOf(address);
        const decimals = await sokoContract.decimals();
        return formatUnits(balance, decimals);
    } catch (error) {
        console.error("Error fetching balance:", error);
        return "0";
    }
};

export const sendSoko = async (toAddress, amount) => {
    try {
        if (!sokoContract) return { success: false, error: "SOKO contract is not configured" };
        if (!isAddress(toAddress)) throw new Error("Invalid recipient address");
        
        const decimals = await sokoContract.decimals();
        const parsedAmount = parseUnits(amount.toString(), decimals);

        // Fetch current fee data to avoid "Underpriced" errors
        const feeData = await provider.getFeeData();

        const tx = await sokoContract.transfer(toAddress, parsedAmount, {
            maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
            maxFeePerGas: feeData.maxFeePerGas
        });

        console.log("Transaction Hash:", tx.hash);
        const receipt = await tx.wait();
        return { success: true, hash: tx.hash, receipt };
    } catch (error) {
        console.error("Transfer failed:", error);
        return { success: false, error: error.message };
    }
};

export const isValidAddress = (address) => {
    return isAddress(address);
};

export const getAdminWalletAddress = () => adminWallet.address;

export default {
    getSokoBalance,
    sendSoko,
    isValidAddress,
    getAdminWalletAddress,
    sokoContract
};
