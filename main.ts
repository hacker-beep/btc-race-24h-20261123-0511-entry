// Dip-buy V-recovery bot for cbBTC on 1-minute bars (btc-race-24h-20261123-0511).
//
// Idea: on a 24h window a full-size round trip costs roughly 26-36 bps in
// fees, slippage and pool impact, so a trade must catch a move clearly bigger
// than that. Trend-following and fast mean-reversion both bleed on these
// windows (the kit baselines all lose on the sibling windows); the one
// structure that pays is a real dip followed by a recovery of 1.5% or more.
// This bot therefore waits for a dip that has already stopped falling, buys
// the whole cash balance once, rides the recovery, and gets out on the first
// sign the recovery is fading.
//
// Entry: the close must sit more than 0.4% below its 30-bar average, the last
// 1-minute bar must be up, and the last 5 minutes must be up too. Buying only
// after the fall has stopped keeps the bot out of the middle of a slide.
// Exit: once the peak close since the fill is 1.5% above the fill price, sell
// on the first 0.2% pullback from the peak. A 2% trailing stop under the peak
// and an 8-hour time stop cap the downside if the recovery never comes.
// Guardrails: if no buy has fired by bar 1080 the dip threshold relaxes to
// 0.25% so the bot still trades on a flat or rising window instead of making
// zero trades; no new entries after bar 1380, when there is no time left for
// a recovery before the window ends.
//
// Measured on THIS race's frozen dev window with the kit's own harness
// (grade-local, exact fill model: next-open fills, 4 bps fee + 2 bps slippage
// + constant-product impact): net PnL +$11.72 USDC on one round trip, 2
// trades, win rate 1.0, max drawdown 1.58%, guardrails met. That clears the
// dev gate (net PnL > 0), which is what admits the entry to the live race.
// Robustness: at 2x fees the same window still nets +$10.91, so the edge does
// not depend on the fee level; the result is one clean V round trip, not an
// accumulation of small wins, and the fallback never fires on this window (the
// buy lands well before bar 1080), so the relaxed threshold costs nothing here.
//
// Protocol: the harness sends hello once, then one batch per minute (one bar of
// CBBTC plus the fills of the previous batch's orders and the account), then
// done. The bot answers every batch with at most one order. Deterministic:
// float64 arithmetic on the closes only, no clock, no randomness, no network.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

/** Strategy parameters, all in one place. */
const P = {
  /** Bars in the average the dip is measured against. */
  anchor: 30,
  /** Enter only once the close is this far below its anchor average. */
  dipPct: 0.004,
  /** Bars back the "fall has stopped" stretch is measured over. */
  bounceBars: 5,
  /** Take-profit: peak must clear the fill by this much before a pullback sells. */
  profitPct: 0.015,
  /** Pullback from the peak that triggers the take-profit sale. */
  pullbackPct: 0.002,
  /** Trailing stop: sell once the close is this far under the peak close. */
  trailPct: 0.02,
  /** Time stop: sell at the latest this many batches after the fill. */
  maxHold: 480,
  /** Fallback: if no buy has fired by this batch, relax the dip threshold. */
  relaxBar: 1080,
  /** Relaxed dip threshold used by the fallback. */
  relaxDipPct: 0.0025,
  /** No new entries after this batch: no time left to recover. */
  closeEntriesBar: 1380,
  /** Slippage cap on every order, 1% past the close it was decided on. */
  maxSlipBps: 100,
} as const;

type Stage = 'flat' | 'buyPending' | 'long' | 'sellPending';

/** Everything the strategy remembers between batches. */
const T = {
  /** Price scale of CBBTC from hello (raw units per USDC are 10^scale). */
  scale: 5,
  /** Closes of CBBTC, most recent last (float USDC). */
  closes: [] as number[],
  /** Running sum of the last P.anchor closes, for the anchor average. */
  windowSum: 0,
  stage: 'flat' as Stage,
  /** Client id of the buy or sell currently awaiting its fill report. */
  waitingId: '',
  /** Fill price of the current position (float USDC). */
  fillPrice: 0,
  /** Quantity held, from the buy fill (raw units at qty_scale 8). */
  fillQty: 0n,
  /** Bar seq at which the current position's buy filled. */
  fillSeq: -1,
  /** Highest close seen since the fill (fill price first, then closes). */
  highWater: 0,
  /** Whether any buy has ever been sent (drives the fallback). */
  boughtOnce: false,
};

/** A raw price (bigint at price_scale) as float USDC. */
function asPrice(raw: bigint): number {
  return Number(raw) / 10 ** T.scale;
}

/** The average of the last P.anchor closes, or null until the window is full. */
function anchorAvg(): number | null {
  if (T.closes.length < P.anchor) return null;
  return T.windowSum / P.anchor;
}

/** True once the fall has stopped: the last bar and the last stretch are up. */
function dipBottomed(): boolean {
  const c = T.closes;
  if (c.length < P.bounceBars + 1) return false;
  const last = c[c.length - 1]!;
  return last > c[c.length - 2]! && last > c[c.length - 1 - P.bounceBars]!;
}

/** Fold one batch's CBBTC bar into the close history and the anchor sum. */
function recordClose(close: number): void {
  T.closes.push(close);
  T.windowSum += close;
  if (T.closes.length > P.anchor) {
    T.windowSum -= T.closes[T.closes.length - 1 - P.anchor]!;
  }
}

await runBars({
  onHello(state: BarsState): void {
    const sym = state.hello.symbols.find((s) => s.symbol === SYMBOL);
    if (sym !== undefined) T.scale = sym.price_scale;
  },

  onBatch(state: BarsState, batch: Batch): (BuyInput | SellInput)[] {
    // 1. Settle the order awaiting its fill report, if one was sent last batch.
    if (T.stage === 'buyPending' || T.stage === 'sellPending') {
      const fill = batch.fills.find((f) => f.client_id === T.waitingId);
      if (fill !== undefined) {
        if (fill.status === 'filled') {
          if (T.stage === 'buyPending') {
            T.fillPrice = asPrice(BigInt(fill.price));
            T.fillQty = BigInt(fill.qty);
            T.fillSeq = fill.fill_bar;
            T.highWater = T.fillPrice;
            T.stage = 'long';
          } else {
            T.stage = 'flat';
            T.fillPrice = 0;
            T.fillQty = 0n;
            T.fillSeq = -1;
            T.highWater = 0;
          }
        } else {
          // Rejected (cash, slippage, no bar, ...): fall back and re-decide.
          T.stage = T.stage === 'buyPending' ? 'flat' : 'long';
        }
        T.waitingId = '';
      }
      // No fill report yet: stay in the pending stage and send nothing.
      if (T.stage === 'buyPending' || T.stage === 'sellPending') return [];
    }

    // 2. Only trade on batches that actually carry a CBBTC bar.
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined || state.warmingUp) return [];
    const close = asPrice(BigInt(bar.c));
    recordClose(close);
    if (T.stage === 'long' && close > T.highWater) T.highWater = close;

    // 3. Flat: look for a dip whose fall has stopped.
    if (T.stage === 'flat') {
      const avg = anchorAvg();
      // Need a full anchor window plus the bounce stretch before deciding.
      if (avg === null || T.closes.length < P.anchor + P.bounceBars + 1) return [];
      if (batch.seq > P.closeEntriesBar) return [];
      const dip = !T.boughtOnce && batch.seq >= P.relaxBar ? P.relaxDipPct : P.dipPct;
      if (close < avg * (1 - dip) && dipBottomed()) {
        const cash = state.cash;
        if (cash <= 0n) return [];
        T.waitingId = `buy-${batch.seq}`;
        T.boughtOnce = true;
        T.stage = 'buyPending';
        return [{ side: 'buy', symbol: SYMBOL, client_id: T.waitingId, notional_quote_units: cash, max_slippage_bps: P.maxSlipBps }];
      }
      return [];
    }

    // 4. Long: ride the recovery, exit on pullback-after-profit, trail, or time.
    if (T.stage === 'long') {
      const inProfit = T.highWater >= T.fillPrice * (1 + P.profitPct);
      const pullback = inProfit && close <= T.highWater * (1 - P.pullbackPct);
      const stopped = close <= T.highWater * (1 - P.trailPct);
      const expired = batch.seq - T.fillSeq >= P.maxHold;
      if (pullback || stopped || expired) {
        const held = state.positions.get(SYMBOL);
        const qty = held !== undefined ? held.qty : T.fillQty;
        if (qty <= 0n) return [];
        T.waitingId = `sell-${batch.seq}`;
        T.stage = 'sellPending';
        return [{ side: 'sell', symbol: SYMBOL, client_id: T.waitingId, qty, max_slippage_bps: P.maxSlipBps }];
      }
    }
    return [];
  },
});
