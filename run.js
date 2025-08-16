require('dotenv').config();
const { ethers } = require("ethers");
const fetch = require('node-fetch');
const chalk = require('chalk');

const PRIVATE_KEY = process.env.PRIVATE_KEY;
const RPC_URL = "https://k8s.testnet.json-rpc.injective.network/";
const ROUTER_ADDRESS = "0x4069f8Ada1a4d3B705e6a82F9A3EB8624Cd4Cb1E";
const CHAIN_ID = 1439;
const API_URL = "https://pumex-api-testnet-e59621f25cf1.herokuapp.com/stats/topTokens";

const SLIPPAGE_BPS = 100; 
const LOOP_SECONDS = 30;
const GAS_BUFFER_BPS = 1500; 
const MODE = "random";

const TOKENS = {
  WINJ: "0x5Ae9B425f58B78e0d5e7e5a7A75c5f5B45d143B7",
  mUSDT: "0xE83c1acd1c9cc3780D0a560E36DCCAA236B86412",
  mDAI:  "0x510B9d0E74480aF149737482884b4aAa82C1A714",
  mUSDC: "0x1d4403F5Ac128dAF548C5ba707D1047b475fDAd2",
  PMX:   "0xeD0094eE59492cB08A5602Eb8275acb00FFb627d"
};

const routerABI = [
  "function getAmountsOut(uint256 amountIn, tuple(address from, address to, bool stable)[] memory routes) public view returns (uint256[] memory amounts)",
  "function swapExactETHForTokens(uint256 amountOutMin, tuple(address from, address to, bool stable)[] calldata routes, address to, uint256 deadline) external payable returns (uint256[] memory amounts)",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, tuple(address from, address to, bool stable)[] calldata routes, address to, uint256 deadline) external returns (uint256[] memory amounts)"
];

const erc20ABI = [
  "function balanceOf(address account) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
  "function allowance(address owner, address spender) external view returns (uint256)",
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function symbol() external view returns (string)"
];

const provider = new ethers.providers.JsonRpcProvider(RPC_URL, CHAIN_ID);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const router = new ethers.Contract(ROUTER_ADDRESS, routerABI, wallet);

const c = {
  dim: s => chalk.dim(s),
  b: s => chalk.bold(s),
  g: s => chalk.green(s),
  r: s => chalk.red(s),
  y: s => chalk.yellow(s),
  c: s => chalk.cyan(s),
  box: (title, lines) => {
    const width = Math.max(title.length + 2, ...lines.map(l => l.length)) + 2;
    const top = "┌" + "─".repeat(width) + "┐";
    const midTitle = `│ ${title}${" ".repeat(width - title.length - 1)}│`;
    const sep = "├" + "─".repeat(width) + "┤";
    const content = lines.map(l => `│ ${l}${" ".repeat(width - l.length - 1)}│`).join("\n");
    const bot = "└" + "─".repeat(width) + "┘";
    return [top, midTitle, sep, content, bot].join("\n");
  },
  chart: (value, max = 100, width = 20) => {
    const barLength = Math.round((value / max) * width);
    const bar = '█'.repeat(barLength) + '░'.repeat(width - barLength);
    return `${bar} ${value.toFixed(2)}%`;
  }
};

function fmtUnits(bn, decimals = 18, digits = 6) {
  try {
    return Number(ethers.utils.formatUnits(bn, decimals)).toFixed(digits);
  } catch {
    return "0";
  }
}
function bnPercent(bn, bps) {
  return bn.mul(10000 - bps).div(10000);
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function randomBetween(min, max) {
  const x = Math.random() * (max - min) + min;
  return ethers.utils.parseEther(x.toFixed(4));
}

async function fetchTopTokensMap() {
  try {
    const res = await fetch(API_URL);
    const json = await res.json();
    const arr = (json && json.data) ? json.data : [];
    const map = {};
    for (const t of arr) {
      map[t.address.toLowerCase()] = {
        symbol: t.symbol,
        decimals: parseInt(t.decimals, 10),
        name: t.name,
        volume24h: t.volume24h ? parseFloat(t.volume24h) : 0
      };
    }
    return map;
  } catch (e) {
    return {};
  }
}

async function getTokenMeta(address) {
  const apiMap = await fetchTopTokensMap();
  const apiMeta = apiMap[address.toLowerCase()];
  if (apiMeta && Number.isFinite(apiMeta.decimals)) return apiMeta;

  const erc = new ethers.Contract(address, erc20ABI, provider);
  const [dec, sym] = await Promise.all([
    erc.decimals().catch(() => 18),
    erc.symbol().catch(() => "TKN")
  ]);
  return { symbol: sym, decimals: Number(dec) || 18, name: sym, volume24h: 0 };
}

async function getGasPriceLegacy() {
  try {
    return await provider.getGasPrice();
  } catch {
    return ethers.utils.parseUnits("0.2", "gwei");
  }
}

async function ensureApproval(tokenAddress, spender, amount) {
  const erc = new ethers.Contract(tokenAddress, erc20ABI, wallet);
  const allowance = await erc.allowance(wallet.address, spender);
  if (allowance.gte(amount)) return;
  const gp = await getGasPriceLegacy();

  const est = await erc.estimateGas.approve(spender, ethers.constants.MaxUint256).catch(() => ethers.BigNumber.from("100000"));
  const gasLimit = est.mul(10000 + GAS_BUFFER_BPS).div(10000);

  const nonce = await provider.getTransactionCount(wallet.address, "latest");
  const tx = await erc.approve(spender, ethers.constants.MaxUint256, {
    gasPrice: gp,
    gasLimit,
    type: 0,
    nonce
  });
  await tx.wait();
}

async function getQuote(amountIn, routes) {
  try {
    const amounts = await router.getAmountsOut(amountIn, routes);
    return { ok: true, amounts, out: amounts[amounts.length - 1] };
  } catch {
    return { ok: false, amounts: [], out: ethers.BigNumber.from(0) };
  }
}

async function hasLiquidity(amountIn, routes) {
  const q = await getQuote(amountIn, routes);
  return q.ok && !q.out.isZero();
}

async function waitLiquidity(amountIn, routes, tries = 12, gapMs = 5000) {
  for (let i = 0; i < tries; i++) {
    if (await hasLiquidity(amountIn, routes)) return true;
    await sleep(gapMs);
  }
  return false;
}

async function drawDashboard(state) {
  console.clear();

  console.log(c.b(chalk.blue("┌────────────────────────────────────────────────────────────────────┐")));
  console.log(c.b(chalk.blue("│             INJECTIVE EVM BOT (PUMEX DAPPS) | BACTIAR291           │")));
  console.log(c.b(chalk.blue("├────────────────────────────────────────────────────────────────────┤")));
  
  console.log(` ${c.b("Network:")} Injective Testnet (chainId ${CHAIN_ID})`);
  console.log(` ${c.b("Router:")}  ${ROUTER_ADDRESS}`);
  console.log(` ${c.b("Wallet:")}  ${wallet.address}`);
  console.log(` ${c.b("Mode:")}     ${MODE}`);
  console.log(` ${c.b("Loop:")}     ${LOOP_SECONDS}s`);
  console.log(c.dim("──────────────────────────────────────────────────────────────────────"));

  console.log(` ${c.b("Balances:")}`);
  console.log(`   INJ   : ${state.balances.INJ || "-"}`);
  console.log(`   WINJ  : ${state.balances.WINJ || "-"}`);
  console.log(`   mUSDC : ${state.balances.mUSDC || "-"}`);
  console.log(`   mDAI  : ${state.balances.mDAI || "-"}`);
  console.log(`   PMX   : ${state.balances.PMX || "-"}`);
  console.log(c.dim("──────────────────────────────────────────────────────────────────────"));

  console.log(` ${c.b("Swap:")} ${state.direction || "-"}`);
  console.log(` ${c.b("Amount:")} ${state.amountInDisp || "-"}`);
  
  if (state.routes.length) {
    console.log(` ${c.b("Route:")}`);
    state.routes.forEach((r, i) => {
      const arrow = r.stable ? "──(stable)──→" : "─(volatile)─→";
      console.log(`   ${(i+1).toString().padStart(2, "0")}. ${r.from} ${arrow} ${r.to}`);
    });
  } else {
    console.log(` ${c.b("Route:")} -`);
  }
  
  console.log(` ${c.b("Quote:")}   ${state.quoteOutDisp || "-"}`);
  console.log(` ${c.b("Min Out:")} ${state.minOutDisp || "-"}`);
  console.log(` ${c.b("Gas:")}     ${state.gasPriceDisp || "-"} | Limit: ${state.gasLimitDisp || "-"}`);
  console.log(` ${c.b("Deadline:")} ${state.deadlineDisp || "-"}`);
  console.log(c.dim("──────────────────────────────────────────────────────────────────────"));

  if (state.volumeData && state.volumeData.length > 0) {
    console.log(` ${c.b("Market Volume:")}`);
    state.volumeData.forEach(item => {
      console.log(`   ${item.symbol.padEnd(6)}: ${c.chart(item.volumePercent, 100, 15)}`);
    });
  }
  console.log(c.dim("──────────────────────────────────────────────────────────────────────"));

  console.log(` ${c.b("Status:")} ${state.status || "Idle"}`);
  console.log(c.dim(` Last update: ${new Date().toLocaleString()}`));
  console.log(c.b(chalk.blue("└────────────────────────────────────────────────────────────────────┘")));
}

async function getBalances() {
  const inj = await provider.getBalance(wallet.address);
  const map = { INJ: `${fmtUnits(inj, 18, 6)} INJ` };

  for (const [sym, addr] of Object.entries(TOKENS)) {
    if (sym === "WINJ") continue;
    try {
      const erc = new ethers.Contract(addr, erc20ABI, provider);
      const [bal, dec] = await Promise.all([erc.balanceOf(wallet.address), erc.decimals()]);
      map[sym] = `${fmtUnits(bal, dec, 6)} ${sym}`;
    } catch {
      map[sym] = "Error";
    }
  }
  
  try {
    const erc = new ethers.Contract(TOKENS.WINJ, erc20ABI, provider);
    const [bal, dec] = await Promise.all([erc.balanceOf(wallet.address), erc.decimals()]);
    map.WINJ = `${fmtUnits(bal, dec, 6)} WINJ`;
  } catch {
    map.WINJ = "Error";
  }
  return map;
}

async function getVolumeData() {
  const apiMap = await fetchTopTokensMap();
  const tokens = Object.values(apiMap).filter(t => 
    t.symbol === "PMX" || t.symbol === "mUSDC" || t.symbol === "mDAI"
  );
  
  if (tokens.length === 0) return null;
  
  const totalVolume = tokens.reduce((sum, t) => sum + (t.volume24h || 0), 0);
  if (totalVolume === 0) return null;
  
  return tokens.map(t => ({
    symbol: t.symbol,
    volumePercent: (t.volume24h / totalVolume) * 100
  }));
}

async function buildRandomPlan() {
  const options = [
    { symbol: "PMX",   address: TOKENS.PMX  },
    { symbol: "mUSDC", address: TOKENS.mUSDC},
    { symbol: "mDAI",  address: TOKENS.mDAI }
  ];
  const pick = options[Math.floor(Math.random() * options.length)];
  const targetMeta = await getTokenMeta(pick.address);

  let direction = MODE;
  if (MODE === "random") direction = Math.random() > 0.5 ? "inj_to_token" : "token_to_inj";

  if (direction === "inj_to_token") {
    const amountIn = randomBetween(0.10, 0.50); 
    const routes = [
      { from: TOKENS.WINJ, to: TOKENS.mUSDT, stable: false },
      { from: TOKENS.mUSDT, to: pick.address, stable: pick.symbol === "mDAI" }
    ];
    return {
      direction,
      tokenOut: pick.address,
      tokenOutMeta: targetMeta,
      amountIn,
      amountInDisp: `${fmtUnits(amountIn, 18, 6)} INJ`,
      routes
    };
  } else {
    const erc = new ethers.Contract(pick.address, erc20ABI, provider);
    const bal = await erc.balanceOf(wallet.address);
    if (bal.isZero()) {
      return { skip: true, reason: `No ${pick.symbol} balance` };
    }
    const p = Math.floor((Math.random() * 0.4 + 0.1) * 100); 
    const amountIn = bal.mul(p).div(100);
    const routes = [
      { from: pick.address, to: TOKENS.mUSDT, stable: false },
      { from: TOKENS.mUSDT, to: TOKENS.WINJ, stable: false }
    ];
    return {
      direction,
      tokenIn: pick.address,
      tokenInMeta: targetMeta,
      amountIn,
      amountInDisp: `${fmtUnits(amountIn, targetMeta.decimals, 6)} ${pick.symbol}`,
      routes
    };
  }
}

async function doOneCycle() {
  const state = {
    balances: await getBalances(),
    volumeData: await getVolumeData(),
    routes: [],
    status: "Preparing…"
  };
  await drawDashboard(state);

  const plan = await buildRandomPlan();
  if (plan.skip) {
    state.status = c.y(`Skip: ${plan.reason}`);
    await drawDashboard(state);
    return;
  }

  state.routes = plan.routes.map(r => ({ from: r.from, to: r.to, stable: r.stable }));
  state.direction = plan.direction === "inj_to_token" ? "INJ → TOKEN" : "TOKEN → INJ";
  state.amountInDisp = plan.amountInDisp;

  state.status = "Checking liquidity…";
  await drawDashboard(state);
  const liquid = await waitLiquidity(plan.amountIn, state.routes, 12, 3000);
  if (!liquid) {
    state.status = c.r("No liquidity. Skipping.");
    await drawDashboard(state);
    return;
  }

  state.status = "Quoting…";
  await drawDashboard(state);
  const quote = await getQuote(plan.amountIn, state.routes);
  if (!quote.ok || quote.out.isZero()) {
    state.status = c.r("Invalid quote. Skipping.");
    await drawDashboard(state);
    return;
  }

  const tokenOutAddr = (plan.direction === "inj_to_token") ? plan.tokenOut : TOKENS.WINJ;
  const tokenOutMeta = (plan.direction === "inj_to_token")
    ? plan.tokenOutMeta
    : await getTokenMeta(TOKENS.WINJ);

  state.quoteOutDisp = `${fmtUnits(quote.out, tokenOutMeta.decimals, 6)} ${tokenOutMeta.symbol}`;
  const minOut = bnPercent(quote.out, SLIPPAGE_BPS);
  state.minOutDisp = `${fmtUnits(minOut, tokenOutMeta.decimals, 6)} ${tokenOutMeta.symbol}`;

  const gasPrice = await getGasPriceLegacy();
  state.gasPriceDisp = `${ethers.utils.formatUnits(gasPrice, "gwei")} gwei`;
  const deadline = Math.floor(Date.now() / 1000) + 300;
  state.deadlineDisp = `${deadline} (in 5m)`;

  try {
    let gasLimitEst;
    if (plan.direction === "inj_to_token") {
      gasLimitEst = await router.estimateGas.swapExactETHForTokens(
        minOut, state.routes, wallet.address, deadline,
        { value: plan.amountIn }
      );
    } else {
      await ensureApproval(plan.tokenIn, ROUTER_ADDRESS, plan.amountIn);
      gasLimitEst = await router.estimateGas.swapExactTokensForETH(
        plan.amountIn, minOut, state.routes, wallet.address, deadline
      );
    }
    const gasLimit = gasLimitEst.mul(10000 + GAS_BUFFER_BPS).div(10000);
    state.gasLimitDisp = `${gasLimit.toString()}`;

    await drawDashboard(state);

    const nonce = await provider.getTransactionCount(wallet.address, "latest");
    state.status = c.c("Sending transaction (legacy)…");
    await drawDashboard(state);

    if (plan.direction === "inj_to_token") {
      const tx = await router.swapExactETHForTokens(
        minOut, state.routes, wallet.address, deadline,
        {
          value: plan.amountIn,
          gasPrice,
          gasLimit,
          type: 0,
          nonce
        }
      );
      state.status = `Sent: ${tx.hash}`;
      await drawDashboard(state);
      const rc = await tx.wait();
      state.status = rc.status === 1 ? c.g(`Success • Block ${rc.blockNumber}`) : c.r("Failed");
      await drawDashboard(state);
    } else {
      const tx = await router.swapExactTokensForETH(
        plan.amountIn, minOut, state.routes, wallet.address, deadline,
        {
          gasPrice,
          gasLimit,
          type: 0,
          nonce
        }
      );
      state.status = `Sent: ${tx.hash}`;
      await drawDashboard(state);
      const rc = await tx.wait();
      state.status = rc.status === 1 ? c.g(`Success • Block ${rc.blockNumber}`) : c.r("Failed");
      await drawDashboard(state);
    }
  } catch (err) {
    state.status = c.r(`Error: ${err.message || err}`);
    await drawDashboard(state);
  }
}

(async function mainLoop() {
  for (;;) {
    try {
      await doOneCycle();
    } catch (e) {
      console.clear();
      console.log(c.r(`Fatal: ${e.message || e}`));
    }

    for (let i = LOOP_SECONDS; i > 0; i--) {
      process.stdout.write(`\r${c.dim(`Next run in ${String(i).padStart(2, "0")}s`)}   `);
      await sleep(1000);
    }
    process.stdout.write("\r                         \r");
  }
})();
