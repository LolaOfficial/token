import { Address, beginCell, Cell, contractAddress, Dictionary, StateInit, storeStateInit, toNano } from "@ton/core";
import TonConnect from "@tonconnect/sdk";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

// Network to deploy the jettons to
const NETWORK: "testnet" | "mainnet" = "mainnet";

// Initial jetton supply: 1,000,000,000 jettons when JETTON_DECIMALS is "6"
const INITIAL_SUPPLY = 1_000_000_000_000_000n;

// Jetton metadata
const JETTON_NAME = "Lola";
const JETTON_SYMBOL = "LOLA";
const JETTON_DESCRIPTION = "Lola token";
const JETTON_IMAGE = "ipfs://bafybeihvohn4rd5fht7ji6i2pjk665emmmxyyuezmbwojzw2erozomjzoi";
const JETTON_DECIMALS = "6";

// --- rest of the script ---
const NETWORK_ID = NETWORK === "mainnet" ? "-239" : "-3";
const TEST_ONLY = NETWORK === "testnet";
const MANIFEST_URL = "https://ton-connect.github.io/demo-dapp-with-wallet/tonconnect-manifest.json";

const require = createRequire(import.meta.url);
const qrcode = require("qrcode-terminal") as {
  generate(input: string, options?: { small?: boolean }): void;
};

class MemoryStorage {
  private readonly data = new Map<string, string>();
  async setItem(key: string, value: string) {
    this.data.set(key, value);
  }
  async getItem(key: string) {
    return this.data.get(key) ?? null;
  }
  async removeItem(key: string) {
    this.data.delete(key);
  }
}

function snakeData(value: string): Cell {
  return beginCell()
    .storeUint(0, 8)
    .storeStringTail(value)
    .endCell();
}

function sha256BigInt(value: string): bigint {
  return BigInt("0x" + createHash("sha256").update(value).digest("hex"));
}

function buildOnchainMetadata(): Cell {
  const entries = [
    ["name", JETTON_NAME],
    ["symbol", JETTON_SYMBOL],
    ["description", JETTON_DESCRIPTION],
    ["image", JETTON_IMAGE],
    ["decimals", JETTON_DECIMALS],
  ];
  const metadata = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
  for (const [key, value] of entries) {
    metadata.set(sha256BigInt(key), snakeData(value));
  }
  return beginCell()
    .storeUint(0, 8)
    .storeDict(metadata)
    .endCell();
}

function buildMinterData(adminAddress: Address): Cell {
  return beginCell()
    .storeCoins(0n)
    .storeAddress(adminAddress)
    .storeAddress(null)
    .storeRef(buildOnchainMetadata())
    .endCell();
}

function buildTopUpBody(): string {
  return beginCell()
    .storeUint(0xd372158c, 32) // TopUpTons
    .endCell()
    .toBoc()
    .toString("base64");
}

function buildMintBody(adminAddress: Address): string {
  const forwardPayload = beginCell()
    .storeUint(0, 32)
    .storeStringTail("Initial mint")
    .endCell();
  const internalTransfer = beginCell()
    .storeUint(0x178d4519, 32) // InternalTransferStep
    .storeUint(0n, 64)
    .storeCoins(INITIAL_SUPPLY)
    .storeAddress(null) // transferInitiator: null when minting
    .storeAddress(adminAddress) // sendExcessesTo
    .storeCoins(toNano("0.02"))
    .storeBit(1) // forwardPayload stored as a reference
    .storeRef(forwardPayload)
    .endCell();
  return beginCell()
    .storeUint(0x642b7d07, 32) // MintNewJettons
    .storeUint(0n, 64)
    .storeAddress(adminAddress)
    .storeCoins(toNano("0.08")) // Gram sent to the admin's jetton wallet
    .storeRef(internalTransfer)
    .endCell()
    .toBoc()
    .toString("base64");
}

async function connectWallet(connector: TonConnect) {
  await connector.restoreConnection();
  if (connector.wallet) {
    return connector.wallet;
  }
  const wallets = (await connector.getWallets())
    .filter((wallet: any) => wallet.bridgeUrl && wallet.universalLink);
  if (wallets.length === 0) {
    throw new Error("No TON Connect wallets with bridge support were found.");
  }
  wallets.slice(0, 10).forEach((wallet: any, index: number) => {
    console.log(`${index + 1}. ${wallet.name}`);
  });
  const rl = createInterface({ input, output });
  const answer = await rl.question("Select wallet [1]: ");
  rl.close();
  const selectedIndex = Math.min(wallets.length - 1, Math.max(0, Number(answer || "1") - 1));
  const selected = wallets[selectedIndex] as any;
  const universalLink = connector.connect({
    bridgeUrl: selected.bridgeUrl,
    universalLink: selected.universalLink,
  });
  console.log(`\nScan this QR code with ${selected.name}, or open the link below:\n`);
  qrcode.generate(universalLink, { small: true });
  console.log(`\n${universalLink}\n`);
  return await new Promise<NonNullable<typeof connector.wallet>>((resolve, reject) => {
    let unsubscribe: (() => void) | undefined;
    const timeout = setTimeout(() => {
      unsubscribe?.();
      reject(new Error("Wallet connection timed out."));
    }, 180_000);
    unsubscribe = connector.onStatusChange((wallet) => {
      if (!wallet) {
        return;
      }
      clearTimeout(timeout);
      unsubscribe?.();
      resolve(wallet);
    }, reject);
  });
}

async function main() {
  const connector = new TonConnect({
    manifestUrl: MANIFEST_URL,
    storage: new MemoryStorage(),
  });
  const wallet = await connectWallet(connector);
  if (wallet.account.chain !== NETWORK_ID) {
    throw new Error(`Switch the connected wallet to ${NETWORK}.`);
  }
  const sendFeature = wallet.device.features.find(
    (feature: any) => typeof feature === "object" && feature.name === "SendTransaction"
  ) as { maxMessages?: number } | undefined;
  if (sendFeature?.maxMessages !== undefined && sendFeature.maxMessages < 2) {
    throw new Error("The connected wallet does not support sending both deploy and mint messages together.");
  }
  const adminAddress = Address.parse(wallet.account.address);
  const code = Cell.fromBase64(readFileSync("build/JettonMinter.base64", "utf-8"));
  const data = buildMinterData(adminAddress);
  const stateInit: StateInit = { code, data };
  const minterAddress = contractAddress(0, stateInit);
  const minterDeployAddress = minterAddress.toString({ testOnly: TEST_ONLY, bounceable: false });
  const minterMintAddress = minterAddress.toString({ testOnly: TEST_ONLY, bounceable: true });
  const stateInitBoc = beginCell()
    .store(storeStateInit(stateInit))
    .endCell()
    .toBoc()
    .toString("base64");
  console.log("Network:", NETWORK);
  console.log("Admin wallet:", adminAddress.toString({ testOnly: TEST_ONLY }));
  console.log("Jetton minter:", minterAddress.toString({ testOnly: TEST_ONLY }));
  console.log("Initial supply:", INITIAL_SUPPLY.toString(), "elementary units");
  console.log("Approve the deploy and mint transaction in the wallet.");
  await connector.sendTransaction({
    validUntil: Math.floor(Date.now() / 1000) + 600,
    network: NETWORK_ID,
    from: wallet.account.address,
    messages: [
      {
        address: minterDeployAddress,
        amount: toNano("0.05").toString(),
        stateInit: stateInitBoc,
        payload: buildTopUpBody(),
      },
      {
        address: minterMintAddress,
        amount: toNano("0.15").toString(),
        payload: buildMintBody(adminAddress),
      },
    ],
  });
  console.log("Transaction sent.");
  console.log("Jetton minter:", minterAddress.toString({ testOnly: TEST_ONLY }));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
