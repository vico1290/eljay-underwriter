import { useState, useRef, useCallback, useEffect } from "react";
// ─── STORAGE SHIM ─── (Claude Artifact-compatible API backed by localStorage)
if (typeof window !== "undefined" && !window.storage) {
  window.storage = {
    get: async (key) => {
      try {
        const v = window.localStorage.getItem(key);
        return v === null ? null : { value: v };
      } catch { return null; }
    },
    set: async (key, value) => {
      try { window.localStorage.setItem(key, value); return true; }
      catch(e) { console.error("localStorage.set failed", e); return false; }
    },
    delete: async (key) => {
      try { window.localStorage.removeItem(key); return true; } catch { return false; }
    },
    list: async () => {
      const out = [];
      for (let i = 0; i < window.localStorage.length; i++) out.push({ key: window.localStorage.key(i) });
      return out;
    },
  };
}
// ─── EL JAY CAPITAL GUIDELINES ───────────────────────────────────────────────
const RESTRICTED_STATES = ["CA", "VA", "NY", "TX"];
const US_STATES = ["AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC"];
const INDUSTRIES = [
  { label: "Restaurant / Food Service", riskMod: 0.12 },
  { label: "Retail", riskMod: 0.08 },
  { label: "Construction / Contractors", riskMod: 0.15 },
  { label: "Healthcare / Medical", riskMod: 0.03 },
  { label: "Auto Repair / Automotive", riskMod: 0.09 },
  { label: "Beauty / Salon / Spa", riskMod: 0.10 },
  { label: "Professional Services", riskMod: 0.04 },
  { label: "Transportation / Trucking", riskMod: 0.13 },
  { label: "E-Commerce", riskMod: 0.07 },
  { label: "Wholesale / Distribution", riskMod: 0.05 },
  { label: "Manufacturing", riskMod: 0.08 },
  { label: "Staffing / Temp Agency", riskMod: 0.18 },
  { label: "Bar / Nightclub", riskMod: 0.20 },
  { label: "Other", riskMod: 0.10 },
];
// ─── UNDERWRITING ENGINE v4 — CAPITAL PRESERVATION FIRST ─────────────────────
// Philosophy: Never chase volume. Protect cash flow. Smaller faster deals beat
// larger longer ones. Every approval must survive 10 consecutive missed payments.
function underwrite(d) {
  const stips = [], flags = [], hardDeclines = [], fraudSignals = [], scorecard = [];
  const protectiveConditions = []; // high-risk approval conditions
  // ── INPUTS ───────────────────────────────────────────────────────────────────
  const avgMonthly      = d.avgMonthly||0;
  const lowestMonth     = d.lowestMonth||0;
  const deposits        = d.depositCount||0;
  const nsfs            = d.nsfs||0;
  const negDays         = d.negativeDays||0;
  const requested       = d.requestedAmount||0;
  const existingBal     = d.existingBalance||0;
  const tib             = d.timeInBusiness||0;
  const fico            = d.creditScore||0;
  const position        = d.position||"2nd";
  const state           = d.state||"";
  const priorDefault    = d.priorDefault||false;
  const mcaHistory      = d.mcaHistory||false;
  const mcaPositions    = d.mcaPositions||[];
  const totalMonthlyMcaBurden = d.totalMonthlyMcaBurden || mcaPositions.reduce((s,p)=>s+(p.totalMonthlyBurden||0),0);
  const industry        = INDUSTRIES.find(i=>i.label===d.industry)||INDUSTRIES[13];
  const avgDailyBalance    = d.avgDailyBalance||0;
  const positionNum = position==="1st"?1:position==="2nd"?2:parseInt(position)||3;
  const isHighPosition = positionNum >= 3;
  const lowestDailyBalance = d.lowestDailyBalance||0;
  const depositFrequency   = d.depositFrequency||"unknown";
  const depositSources     = d.depositSources||1;
  const topSourcePct       = d.topSourcePct||100;
  const cashWithdrawPct    = d.cashWithdrawPct||0;
  const nsf30 = d.nsf30||0, nsf60 = d.nsf60||0, nsf90 = d.nsf90||0;
  const revTrend     = d.revTrend||"flat";
  const revVolatility= d.revVolatility||"low";
  const mo3avg = d.mo3avg||avgMonthly;
  const mo6avg = d.mo6avg||avgMonthly;
  const patterns           = d.patterns||{};
  const hasPayrollCycle    = patterns.payrollCycle||false;
  const hasSeasonality     = patterns.seasonality||false;
  const hasOwnerTransfers  = patterns.ownerTransfersIncreasing||false;
  const hasCashSpike       = patterns.cashWithdrawalSpike||false;
  const rapidPayoffHistory = patterns.rapidMcaPayoffHistory||false;
  const multiLenderPulls   = patterns.multiLenderBankPulls||false;
  // ── HARD DECLINES ─────────────────────────────────────────────────────────────
  if (RESTRICTED_STATES.includes(state))
    hardDeclines.push(`State ${state} — El Jay does not fund CA, VA, NY, or TX`);
  if (priorDefault)
    hardDeclines.push("Prior MCA default on record — El Jay requires clean MCA history");
  if (avgMonthly < 5000)
    hardDeclines.push(`Monthly revenue $${avgMonthly.toLocaleString()} below $5K minimum`);
  if (position === "1st")
    hardDeclines.push("1st position — El Jay does not fund 1st position deals");
  if (requested > 70000)
    hardDeclines.push(`Requested $${requested.toLocaleString()} exceeds $70K maximum`);
  if (totalMonthlyMcaBurden > 0 && avgMonthly > 0 && (totalMonthlyMcaBurden/avgMonthly) > 0.55)
    hardDeclines.push(`MCA debt service ${Math.round((totalMonthlyMcaBurden/avgMonthly)*100)}% of revenue — exceeds 55% hard limit`);
  // Stacking hard limits
  const numPositions = mcaPositions.length;
  if (numPositions >= 7 && positionNum >= 8)
    hardDeclines.push("8th+ position stacking — El Jay will not enter beyond 7th position");
  // 10-day miss test hard stop
  const avgDailyDeposits = avgMonthly > 0 ? avgMonthly / 22 : 0; // 22 business days/mo (Mon-Fri only)
  const stackDailyPayments = totalMonthlyMcaBurden > 0 ? totalMonthlyMcaBurden / 22 : 0; // ACH pulls Mon-Fri only, ~22x/mo
  const proposedDailyEst = requested > 0 ? Math.round((requested * 1.50) / 80) : 0;
  const totalDailyObligations = stackDailyPayments + proposedDailyEst;
  const tenDayExposure = proposedDailyEst * 10;
  const tenDayMissRatio = avgDailyBalance > 0 ? tenDayExposure / avgDailyBalance : 99;
  if (tenDayMissRatio > 2.0 && avgDailyBalance > 0 && proposedDailyEst > 0)
    hardDeclines.push(`10-day miss test failed — 10 missed payments ($${(tenDayExposure).toLocaleString()}) exceeds 2× avg daily balance ($${avgDailyBalance.toLocaleString()})`);
  if (hardDeclines.length > 0) return {
    decision:"DECLINE", hardDeclines, fraudSignals:[], stips:[], flags:[], scorecard:[],
    approvedAdvance:0, factorRate:0, termDays:0, payback:0, dailyPayment:0, weeklyPayment:0,
    totalScore:0, mcaPositions, totalMonthlyMcaBurden, burdenPct:0,
    riskBand:"DECLINE", riskProfile:null, cashFlowSafety:null, protectiveConditions:[]
  };
  // ════════════════════════════════════════════════════════════
  // A — BANK ACCOUNT INTELLIGENCE (30 pts)
  // ════════════════════════════════════════════════════════════
  let bankScore = 0;
  if (avgDailyBalance >= 15000) bankScore += 8;
  else if (avgDailyBalance >= 8000) bankScore += 6;
  else if (avgDailyBalance >= 4000) { bankScore += 3; flags.push(`Avg daily balance $${avgDailyBalance.toLocaleString()} — thin cushion`); }
  else if (avgDailyBalance > 0) { bankScore += 1; flags.push(`Low avg daily balance $${avgDailyBalance.toLocaleString()} — high default risk`); stips.push("Full 90-day daily balance review required"); }
  if (lowestDailyBalance < 0) { bankScore -= 2; flags.push(`Account dipped negative — lowest: $${lowestDailyBalance.toLocaleString()}`); }
  else if (lowestDailyBalance < 500) { flags.push(`Lowest daily balance $${lowestDailyBalance.toLocaleString()} — account barely stays positive`); }
  else if (lowestDailyBalance >= 2000) bankScore += 4;
  else bankScore += 2;
  if (depositFrequency === "daily") bankScore += 5;
  else if (depositFrequency === "weekly") { bankScore += 3; flags.push("Weekly deposit cadence — lower cash flow visibility"); }
  else if (depositFrequency === "sporadic") { flags.push("Sporadic deposits — unpredictable repayment"); stips.push("Explain irregular deposit pattern"); }
  if (depositSources >= 5) bankScore += 5;
  else if (depositSources >= 3) bankScore += 3;
  else if (depositSources >= 2) bankScore += 2;
  else { flags.push("Single deposit source — concentration risk"); stips.push("Explain single-source dependency"); }
  if (topSourcePct > 80) flags.push(`Top source is ${topSourcePct}% of all revenue — dangerous concentration`);
  if (cashWithdrawPct >= 30) { bankScore -= 3; flags.push(`Cash withdrawals ${cashWithdrawPct}% of outflows — possible revenue hiding`); stips.push("Explain high cash withdrawal activity"); }
  else if (cashWithdrawPct >= 15) flags.push(`Cash withdrawals ${cashWithdrawPct}% of outflows — monitor closely`);
  bankScore = Math.max(0, Math.min(bankScore, 30));
  scorecard.push({ label:"Bank Account Intelligence", max:30, earned:bankScore,
    detail:`Avg daily $${avgDailyBalance.toLocaleString()} · min $${lowestDailyBalance.toLocaleString()} · ${depositFrequency} · ${depositSources} source${depositSources!==1?"s":""} · ${cashWithdrawPct}% cash` });
  // ════════════════════════════════════════════════════════════
  // B — REVENUE QUALITY (25 pts) — stable $40k beats erratic $70k
  // ════════════════════════════════════════════════════════════
  let revScore = 0;
  const useRev = mo3avg > 0 ? mo3avg : avgMonthly;
  if (useRev >= 80000) revScore += 8; else if (useRev >= 50000) revScore += 6;
  else if (useRev >= 35000) revScore += 4; else if (useRev >= 20000) revScore += 2; else if (useRev >= 5000) revScore += 1;
  if (revTrend === "up") revScore += 6;
  else if (revTrend === "flat") revScore += 4;
  else if (revTrend === "down") { revScore += 1; flags.push("Revenue trending downward — declining business health"); stips.push("Cover letter explaining revenue decline required"); }
  else if (revTrend === "volatile") { revScore += 2; flags.push("Volatile revenue — advance will be sized to floor, not average"); }
  if (revVolatility === "low") revScore += 6;
  else if (revVolatility === "medium") revScore += 3;
  else { flags.push("High revenue volatility — month-to-month swings are significant"); stips.push("3-month rolling average used for sizing — no exceptions"); }
  const consistency = avgMonthly > 0 ? lowestMonth/avgMonthly : 0;
  if (consistency >= 0.80) revScore += 5;
  else if (consistency >= 0.65) { revScore += 3; flags.push(`Lowest month is ${Math.round(consistency*100)}% of average`); }
  else if (consistency >= 0.45) { revScore += 1; flags.push("Significant low-month variance"); stips.push("Seasonality or variance explanation required"); }
  else { flags.push("Extreme revenue variance — worst month <45% of average"); stips.push("Written explanation + supporting documentation for low months"); }
  revScore = Math.max(0, Math.min(revScore, 25));
  scorecard.push({ label:"Revenue Quality & Trend", max:25, earned:revScore,
    detail:`3mo $${mo3avg.toLocaleString()} · 6mo $${mo6avg.toLocaleString()} · ${revTrend} · volatility: ${revVolatility}` });
  // ════════════════════════════════════════════════════════════
  // C — CASH FLOW STRESS (20 pts)
  // ════════════════════════════════════════════════════════════
  let cashScore = 0;
  const nsfUse = nsf90 > 0 ? nsf90 : nsfs * 3;
  if (nsfUse === 0) cashScore += 10;
  else if (nsfUse <= 2) { cashScore += 8; flags.push(`${nsfUse} NSF(s) in 90 days — minor`); }
  else if (nsfUse <= 5) { cashScore += 5; flags.push(`${nsfUse} NSFs in 90 days — moderate stress`); stips.push("3 months bank statements for NSF pattern review"); }
  else if (nsfUse <= 10) { cashScore += 2; flags.push(`${nsfUse} NSFs in 90 days — significant cash mismanagement`); stips.push("6 months statements + written NSF explanation"); }
  else { flags.push(`${nsfUse}+ NSFs in 90 days — severe`); stips.push("NSF pattern must be resolved before any funding"); }
  if (nsf30 > 0 && nsf60 > 0 && nsf30 >= nsf60/2) flags.push("NSF frequency worsening in most recent 30 days");
  if (negDays === 0) cashScore += 6;
  else if (negDays <= 2) cashScore += 4;
  else if (negDays <= 5) { cashScore += 2; flags.push(`${negDays} negative days/month`); stips.push("Explain negative balance days"); }
  else { flags.push(`Account negative ${negDays}+ days/month — chronic overdraft`); stips.push("Account must be positive at time of funding — verified same day"); }
  // Safe daily payment check — can the account absorb our debit?
  const safeDaily = avgDailyBalance > 0 ? Math.round(avgDailyBalance * 0.12) : 0; // 12% of avg daily bal is "safe"
  if (avgDailyBalance > 0 && proposedDailyEst > 0) {
    const cushionRatio = avgDailyBalance / proposedDailyEst;
    if (cushionRatio >= 5) cashScore += 4;
    else if (cushionRatio >= 3) cashScore += 2;
    else if (cushionRatio < 2) { flags.push(`Daily cushion only ${cushionRatio.toFixed(1)}× proposed payment — thin margin for error`); stips.push("Confirm daily ACH capacity before funding"); }
  }
  cashScore = Math.max(0, Math.min(cashScore, 20));
  scorecard.push({ label:"Cash Flow Stress Test", max:20, earned:cashScore,
    detail:`${nsf30} NSF/30d · ${nsf60}/60d · ${nsf90}/90d · ${negDays} neg days · safe daily ~$${safeDaily.toLocaleString()}` });
  // ════════════════════════════════════════════════════════════
  // D — MCA STACK & STACKING TOLERANCE (15 pts)
  // Stacking tolerated ONLY if: total MCA payments ≤ 18% avg daily deposits,
  // not junior beyond 2nd, remaining balances are short-term
  // ════════════════════════════════════════════════════════════
  let stackScore = 0;
  if (position === "2nd") stackScore += 7;
  else if (isHighPosition) {
    const posScore = Math.max(0, 5 - (positionNum - 3)); // 3rd=5, 4th=4, 5th=3, 6th=2, 7th=1
    stackScore += posScore;
    flags.push(`${position} position — elevated stack risk`);
    stips.push("Payoff letters for ALL active positions required before funding");
  }
  if (mcaHistory) stackScore += 4;
  else { stackScore += 1; flags.push("No prior MCA history — first advance"); stips.push("First-time MCA explanation required"); }
  const burdenPct = avgMonthly > 0 ? totalMonthlyMcaBurden / avgMonthly : 0;
  const stackingPctOfDailyDeposits = avgDailyBalance > 0 ? (stackDailyPayments / avgDailyDeposits) * 100 : 0;
  if (numPositions > 0) {
    if (burdenPct <= 0.40) {
      stackScore += 4;
    } else {
      stackScore -= 2; flags.push(`MCA burden ${Math.round(burdenPct*100)}% of revenue — approaching hard limit of 55%`);
      stips.push("Net cash position must improve after funding — demonstrate with payoff schedule");
      protectiveConditions.push("Advance sized conservatively given high existing burden");
    }
    if (numPositions >= 3) {
      stackScore -= 3; flags.push(`${numPositions} active MCA positions — maximum stacking exposure`);
      stips.push("Full disclosure: payoff letters + remaining terms for all lenders");
      protectiveConditions.push("Mandatory payoff of oldest position at closing");
    } else if (numPositions === 2) {
      stips.push("Payoff letter or current balance statement for each active MCA");
    }
    // Check if remaining balances are short-term (estimated)
    const longPositions = mcaPositions.filter(p => p.estimatedRemainingBalance > (p.totalMonthlyBurden||1) * 3);
    if (longPositions.length > 0) {
      flags.push(`${longPositions.length} position(s) with long estimated remaining term — stacking risk elevated`);
    }
  } else if (existingBal > 0) {
    const dsr = existingBal/avgMonthly;
    if (dsr > 1.5) { stackScore -= 3; flags.push(`Existing MCA balance ${dsr.toFixed(1)}× monthly revenue`); stips.push("Net funded must retire at least one position"); }
    else if (dsr > 0.8) { flags.push(`Existing balance ${dsr.toFixed(1)}× monthly revenue`); stips.push("Confirm current daily debit obligations"); }
  }
  stackScore = Math.max(0, Math.min(stackScore, 15));
  const stackDetail = numPositions > 0
    ? `${numPositions} lender${numPositions>1?"s":""} · $${totalMonthlyMcaBurden.toLocaleString()}/mo · ${Math.round(burdenPct*100)}% rev · ${Math.round(stackingPctOfDailyDeposits)}% daily deps`
    : `${position} · ${mcaHistory?"MCA history":"first advance"}`;
  scorecard.push({ label:"MCA Stack & Stacking Risk", max:15, earned:stackScore, detail:stackDetail });
  // Business profile — flags & stips only, not scored
  if (tib < 12) { flags.push("<12 months TIB — elevated early-stage risk"); stips.push("All bank statements + proof of business (lease/license/EIN)"); }
  if (fico > 0 && fico < 500) { flags.push("FICO below 500 — significant credit risk"); stips.push("PG required; co-signer strongly recommended"); }
  else if (fico > 0 && fico < 550) { flags.push("FICO below 550"); stips.push("PG required + written explanation of derogatory marks"); }
  else if (fico > 0 && fico < 600) { flags.push("FICO below 600"); stips.push("Personal guarantee from all owners >20%"); }
  if (industry.riskMod > 0.15) { flags.push(`High-risk industry: ${industry.label}`); stips.push("Industry addendum required"); }
  // ════════════════════════════════════════════════════════════
  // FRAUD & BEHAVIORAL SIGNALS
  // ════════════════════════════════════════════════════════════
  if (multiLenderPulls)   fraudSignals.push({ level:"high",   msg:"Multiple lenders pulling statements simultaneously — desperation signal" });
  if (hasCashSpike)       fraudSignals.push({ level:"medium", msg:"Cash withdrawals spiking — possible revenue diversion post-funding" });
  if (hasOwnerTransfers)  fraudSignals.push({ level:"medium", msg:"Owner transfers increasing — funds leaving the business" });
  if (rapidPayoffHistory) fraudSignals.push({ level:"medium", msg:"Serial rapid payoff/refinance pattern — churning risk" });
  if (hasPayrollCycle)    fraudSignals.push({ level:"info",   msg:"Payroll cycle detected — schedule ACH to avoid payroll day conflicts" });
  if (hasSeasonality)     fraudSignals.push({ level:"info",   msg:"Seasonal revenue — advance sized to off-season floor, not peak" });
  const highFraud = fraudSignals.filter(s=>s.level==="high").length;
  const totalScore0 = bankScore + revScore + cashScore + stackScore;
  const fraudPenalty = highFraud >= 2 ? 15 : highFraud === 1 ? 7 : 0;
  // FEATURE 1: Apply industry.riskMod (0.03–0.20) as scoring penalty (max 4 pts)
  const industryPenalty = Math.min(Math.round(industry.riskMod * 20), 4);
  const totalScore = Math.max(0, totalScore0 - fraudPenalty - industryPenalty);
  if (fraudPenalty > 0) flags.push(`Fraud signal penalty: -${fraudPenalty} pts`);
  if (industryPenalty > 0) flags.push(`Industry risk adjustment: -${industryPenalty} pts (${industry.label})`);
  // ════════════════════════════════════════════════════════════
  // RISK BAND CLASSIFICATION
  // ════════════════════════════════════════════════════════════
  const riskBand = totalScore >= 68 ? "LOW RISK" : totalScore >= 54 ? "MODERATE RISK" : totalScore >= 36 ? "HIGH RISK" : "VERY HIGH RISK";
  const keyRiskDrivers = [];
  if (bankScore < 15) keyRiskDrivers.push("Weak bank account health");
  if (revScore < 12)  keyRiskDrivers.push(revTrend === "down" ? "Declining revenue trend" : "Revenue instability");
  if (cashScore < 10) keyRiskDrivers.push("Cash flow stress / NSF history");
  if (stackScore < 7) keyRiskDrivers.push("Heavy MCA stack burden");
  if (highFraud > 0)  keyRiskDrivers.push("Behavioral / fraud signals detected");
  if (industryPenalty >= 3) keyRiskDrivers.push(`Elevated industry risk: ${industry.label}`);
  if (keyRiskDrivers.length === 0) keyRiskDrivers.push("No major risk drivers identified");
  // ════════════════════════════════════════════════════════════
  // CASH FLOW SAFETY ANALYSIS
  // ════════════════════════════════════════════════════════════
  // Conservative base revenue = lowest of: 3mo avg, overall avg, or floor from lowestMonth
  const conservativeRev = mo3avg > 0 ? Math.min(mo3avg, avgMonthly) : avgMonthly;
  const floorRev = hasSeasonality && lowestMonth > 0 ? Math.max(lowestMonth, conservativeRev * 0.6) : conservativeRev;
  const effectiveRev = revVolatility === "high" || revTrend === "down" ? floorRev : conservativeRev;
  // Safe daily payment = what the account can absorb without triggering NSFs
  // Based on: (avg daily balance × 12%) OR (avg daily deposits - existing obligations) × 25%
  const safePaymentFromBalance = avgDailyBalance > 0 ? Math.round(avgDailyBalance * 0.12) : 0;
  const safePaymentFromFlow = avgDailyDeposits > 0 ? Math.round((avgDailyDeposits - stackDailyPayments) * 0.25) : 0;
  const safeDailyPayment = Math.max(Math.min(safePaymentFromBalance, safePaymentFromFlow), 50);
  // Stress test: can the merchant survive?
  const stressTestPass = tenDayMissRatio <= 1.0; // 10 missed payments ≤ avg daily balance
  const stressTestNote = stressTestPass
    ? `PASS — 10-day miss exposure ($${tenDayExposure.toLocaleString()}) within avg daily balance ($${avgDailyBalance.toLocaleString()})`
    : `MARGINAL — 10-day miss ($${tenDayExposure.toLocaleString()}) is ${tenDayMissRatio.toFixed(1)}× avg daily balance`;
  // ════════════════════════════════════════════════════════════
  // CAPITAL-PRESERVATION SIZING
  // Short, small, expensive beats long, large, cheap for high-risk
  // ════════════════════════════════════════════════════════════
  let maxMultiple, termDays, payFrequency;
  if (totalScore >= 68) {
    maxMultiple = 1.50; termDays = 120; payFrequency = "daily";
  } else if (totalScore >= 54) {
    maxMultiple = 1.25; termDays = 100; payFrequency = "daily";
  } else if (totalScore >= 41) {
    maxMultiple = 0.85; termDays = 80; payFrequency = "daily";
    protectiveConditions.push("Shortened 80-day term to reduce time-at-risk");
    protectiveConditions.push("Advance capped at 85% of monthly revenue");
  } else {
    maxMultiple = 0.60; termDays = 60; payFrequency = "daily";
    protectiveConditions.push("Emergency minimum structure: 60-day term only");
    protectiveConditions.push("Advance capped at 60% of monthly revenue — capital preservation mode");
    protectiveConditions.push("Last position only — no senior exposure");
  }
  // Adjust sizing for risk factors
  if (revTrend === "down")      { maxMultiple -= 0.20; termDays = Math.min(termDays, 80); protectiveConditions.push("Declining revenue: advance reduced 20%, term capped at 80 days"); }
  if (revVolatility === "high") { maxMultiple -= 0.15; termDays = Math.min(termDays, 80); protectiveConditions.push("High volatility: advance reduced, term shortened"); }
  if (numPositions >= 2)        { maxMultiple -= 0.15; protectiveConditions.push("Active stacking: advance reduced to protect overall cash flow position"); }
  if (isHighPosition)      { maxMultiple -= (0.10 + (positionNum-3)*0.05); protectiveConditions.push(`${position} position: advance exposure cap enforced`); }
  if (hasSeasonality)           { maxMultiple = Math.min(maxMultiple, 0.75); protectiveConditions.push("Seasonal business: sized to off-season floor revenue"); }
  if (highFraud > 0)            { maxMultiple -= 0.15; termDays = Math.min(termDays, 70); }
  maxMultiple = Math.max(maxMultiple, 0.40);
  termDays = Math.max(termDays, 60);
  const maxAdvance = Math.min(Math.round(effectiveRev * maxMultiple), 70000);
  const factorEst = 1.50;
  const paymentCapAdvance = safeDailyPayment > 0 ? Math.round((safeDailyPayment * termDays) / factorEst) : maxAdvance;
  const finalMaxAdvance = Math.min(maxAdvance, paymentCapAdvance, 70000);
  let approvedAdvance = Math.min(requested || finalMaxAdvance, finalMaxAdvance);
  approvedAdvance = Math.max(approvedAdvance, 5000);
  if (requested > finalMaxAdvance) {
    flags.push(`Requested $${requested.toLocaleString()} — capped at $${finalMaxAdvance.toLocaleString()} by risk-adjusted sizing`);
    stips.push(`Advance structured at $${finalMaxAdvance.toLocaleString()} — capital preservation override`);
    approvedAdvance = finalMaxAdvance;
  }
  // ── FACTOR RATE — fixed 1.50 on all deals ────────────────────────────────────
  const factorRate = 1.50;
  // ── PAYMENTS ─────────────────────────────────────────────────────────────────
  const payback = Math.round(approvedAdvance * factorRate);
  const dailyPayment = Math.round(payback / termDays);
  const weeklyPayment = Math.round(payback / (termDays / 5));
  // ── PROTECTIVE CONDITIONS ────────────────────────────────────────────────────
  if (totalScore < 54) {
    if (!protectiveConditions.some(c=>c.includes("guarantee"))) protectiveConditions.push("Personal guarantee required from all owners >20%");
    if (rapidPayoffHistory) protectiveConditions.push("No refinance / stacking within first 45 days — minimum seasoning required");
    if (highFraud > 0) protectiveConditions.push("Senior underwriter sign-off required before funding");
  }
  if (dailyPayment > safePaymentFromFlow && safePaymentFromFlow > 0) {
    protectiveConditions.push(`Daily payment $${dailyPayment.toLocaleString()} exceeds comfort threshold — consider weekly ACH structure`);
    payFrequency = "weekly (recommended)";
  }
  // ── PRICING TIER LABEL ────────────────────────────────────────────────────────
  const pricingTier = "1.50 Factor";
  // ── DECISION ─────────────────────────────────────────────────────────────────
  let decision, rationale;
  if (totalScore >= 59 && stips.length === 0 && highFraud === 0) {
    decision = "APPROVE";
    rationale = `Score ${totalScore}/90 — clean profile. Standard structure approved.`;
  } else if (totalScore >= 50 && stips.length <= 4) {
    decision = "APPROVE_STIPS";
    rationale = `Score ${totalScore}/90 — approved with stipulations. ${stips.length} condition(s) must be satisfied before funding.`;
  } else if (totalScore >= 32) {
    decision = "CONDITIONAL";
    rationale = `Score ${totalScore}/90 — high-risk conditional. Advance reduced to $${approvedAdvance.toLocaleString()}, term ${termDays} days, ${pricingTier}. All protective conditions must be met.`;
    if (!protectiveConditions.some(c=>c.includes("trial"))) protectiveConditions.push("Consider trial period: fund 50% now, remaining 50% after 30-day payment performance");
  } else {
    decision = "COUNTER";
    rationale = `Score ${totalScore}/90 — deal as presented does not meet minimum thresholds. Minimum viable counter at $${Math.max(Math.round(effectiveRev * 0.40), 5000).toLocaleString()} / 60 days only if merchant resolves: ${flags.slice(0,2).join("; ")}.`;
    approvedAdvance = Math.max(Math.round(effectiveRev * 0.40), 5000);
  }
  const counterOffer = (decision === "COUNTER" || decision === "CONDITIONAL")
    ? { reducedAdvance: approvedAdvance, note: rationale } : null;
  // ── RISK PROFILE OUTPUT ───────────────────────────────────────────────────────
  const riskProfile = {
    score: totalScore,
    riskBand,
    keyRiskDrivers,
  };
  const cashFlowSafety = {
    safeDailyPayment,
    stressTestResult: stressTestNote,
    stressTestPass,
    tenDayExposure,
    effectiveRevUsed: effectiveRev,
    maxDollarsAtRisk: approvedAdvance,
    timeExposed: `${termDays} days`,
    payFrequency,
  };
  return {
    decision, hardDeclines:[], totalScore, scorecard, flags, stips, fraudSignals,
    approvedAdvance, maxAdvance: finalMaxAdvance, factorRate, termDays, payback,
    dailyPayment, weeklyPayment, counterOffer, mcaPositions, totalMonthlyMcaBurden,
    burdenPct: avgMonthly > 0 ? totalMonthlyMcaBurden/avgMonthly : 0,
    riskBand, riskProfile, cashFlowSafety, protectiveConditions, pricingTier, rationale,
    industryPenalty, fraudPenalty
  };
}
function seasonalNote(seasonal, trend) {
  if (seasonal) return "Seasonal business — counter sized to off-season baseline revenue.";
  if (trend === "down") return "Declining revenue trend — offer reduced pending merchant explanation.";
  return "Reduced offer pending stipulation resolution and resubmission.";
}
// ─── DEAL MEMORY ENGINE ───────────────────────────────────────────────────────
// Persists every funded deal + outcome. Builds pattern intelligence over time.
async function saveDeal(deal) {
  try {
    const id = `deal:${Date.now()}`;
    await window.storage.set(id, JSON.stringify(deal));
    // Also update aggregate stats
    const statsRaw = await window.storage.get("eljay:stats").catch(()=>null);
    const stats = statsRaw ? JSON.parse(statsRaw.value) : { totalDeals:0, defaults:0, earlyPayoffs:0, cleanRefi:0, industries:{}, isoVsDirect:{iso:0,direct:0}, scoreRanges:{} };
    stats.totalDeals++;
    if (deal.outcome === "default") stats.defaults++;
    if (deal.outcome === "early_payoff") stats.earlyPayoffs++;
    if (deal.outcome === "clean_refi") stats.cleanRefi++;
    if (deal.industry) stats.industries[deal.industry] = (stats.industries[deal.industry]||{total:0,defaults:0,payoffs:0});
    if (deal.industry) { stats.industries[deal.industry].total++; if(deal.outcome==="default") stats.industries[deal.industry].defaults++; if(deal.outcome==="early_payoff"||deal.outcome==="clean_refi") stats.industries[deal.industry].payoffs++; }
    if (deal.channel) stats.isoVsDirect[deal.channel] = (stats.isoVsDirect[deal.channel]||0)+1;
    const bracket = deal.score>=80?"80-100":deal.score>=65?"65-79":deal.score>=50?"50-64":"0-49";
    if (!stats.scoreRanges[bracket]) stats.scoreRanges[bracket]={total:0,defaults:0,payoffs:0};
    stats.scoreRanges[bracket].total++;
    if (deal.outcome==="default") stats.scoreRanges[bracket].defaults++;
    if (deal.outcome==="early_payoff"||deal.outcome==="clean_refi") stats.scoreRanges[bracket].payoffs++;
    await window.storage.set("eljay:stats", JSON.stringify(stats));
    return id;
  } catch(e) { console.error("saveDeal error", e); return null; }
}
async function loadAllDeals() {
  try {
    const listResult = await window.storage.list("deal:");
    const keys = listResult?.keys || [];
    const deals = await Promise.all(keys.map(async k => {
      try { const r = await window.storage.get(k); return r ? JSON.parse(r.value) : null; } catch { return null; }
    }));
    return deals.filter(Boolean).sort((a,b)=>b.timestamp-a.timestamp);
  } catch { return []; }
}
async function loadStats() {
  try {
    const r = await window.storage.get("eljay:stats");
    return r ? JSON.parse(r.value) : null;
  } catch { return null; }
}
async function updateDealOutcome(dealId, outcome, notes) {
  try {
    const r = await window.storage.get(dealId);
    if (!r) return false;
    const deal = JSON.parse(r.value);
    deal.outcome = outcome;
    deal.outcomeNotes = notes;
    deal.outcomeDate = new Date().toISOString();
    await window.storage.set(dealId, JSON.stringify(deal));
    // Update stats
    const statsRaw = await window.storage.get("eljay:stats").catch(()=>null);
    if (statsRaw) {
      const stats = JSON.parse(statsRaw.value);
      if (outcome==="default") { stats.defaults++; if(deal.industry&&stats.industries[deal.industry]) stats.industries[deal.industry].defaults++; const bracket=deal.score>=80?"80-100":deal.score>=65?"65-79":deal.score>=50?"50-64":"0-49"; if(stats.scoreRanges[bracket]) stats.scoreRanges[bracket].defaults++; }
      if (outcome==="early_payoff"||outcome==="clean_refi") { stats.earlyPayoffs++; }
      await window.storage.set("eljay:stats", JSON.stringify(stats));
    }
    return true;
  } catch { return false; }
}
async function getPatternInsights(currentDeal, allDeals) {
  if (!allDeals || allDeals.length < 3) return null;
  try {
    const completedDeals = allDeals.filter(d=>d.outcome&&d.outcome!=="pending"&&d.outcome!=="funded");
    if (completedDeals.length < 3) return null;
    const response = await fetch("/api/anthropic", {
      method:"POST", headers:{"Content-Type":"application/json"},
      body: JSON.stringify({
        model:"claude-sonnet-4-6", max_tokens:1000,
        messages:[{ role:"user", content:`You are El Jay Capital's proprietary underwriting intelligence system. You have access to historical deal outcomes. Analyze the current deal against the pattern database and return ONLY raw JSON — no markdown, no backticks.
HISTORICAL DEALS (${completedDeals.length} completed deals):
${JSON.stringify(completedDeals.map(d=>({industry:d.industry,score:d.score,avgMonthly:d.avgMonthly,revTrend:d.revTrend,revVolatility:d.revVolatility,position:d.position,numMcaPositions:d.numMcaPositions,burdenPct:d.burdenPct,avgDailyBalance:d.avgDailyBalance,nsf90:d.nsf90,tib:d.timeInBusiness,fico:d.creditScore,channel:d.channel,advanceAmount:d.advanceAmount,outcome:d.outcome,outcomeNotes:d.outcomeNotes||""})))}
CURRENT DEAL:
${JSON.stringify({industry:currentDeal.industry,score:currentDeal.score,avgMonthly:currentDeal.avgMonthly,revTrend:currentDeal.revTrend,revVolatility:currentDeal.revVolatility,position:currentDeal.position,numMcaPositions:(currentDeal.mcaPositions||[]).length,burdenPct:currentDeal.burdenPct,avgDailyBalance:currentDeal.avgDailyBalance,nsf90:currentDeal.nsf90,tib:currentDeal.timeInBusiness,fico:currentDeal.creditScore,channel:currentDeal.channel||"iso",advanceAmount:currentDeal.approvedAdvance})}
Return:
{
  "similarDeals": number (how many historical deals are similar to this one — similar industry, score range, position),
  "similarDefaults": number (how many similar deals defaulted),
  "similarPayoffs": number (how many similar deals paid off clean),
  "predictedOutcome": "likely_payoff" | "moderate_risk" | "high_risk" | "likely_default",
  "confidenceLevel": "high" | "medium" | "low" (based on sample size),
  "patternWarnings": [ string ] (specific patterns from historical data that concern you about THIS deal — be specific, cite what you learned from the data),
  "patternStrengths": [ string ] (patterns from data that support this deal),
  "learningInsight": string (1-2 sentence insight: what does El Jay's own deal history say about deals like this one? Be specific with numbers if possible),
  "recommendedAdjustment": string or null (if historical data suggests a different advance amount, factor rate, or condition — state it specifically)
}` }]
      })
    });
    const data = await response.json();
    const text = data.content?.find(b=>b.type==="text")?.text||"";
    return JSON.parse(text.replace(/```json|```/g,"").trim());
  } catch(e) { console.error("getPatternInsights error",e); return null; }
}
// ─── LENDER MEMORY ────────────────────────────────────────────────────────────
// Tracks which names the underwriter has confirmed are actual MCA lenders
// and which have been rejected as false positives. Feeds back into AI analysis.
const LENDER_KNOWN_KEY = "eljay:lenders:known";
const LENDER_REJECTED_KEY = "eljay:lenders:rejected";
function _normalizeLender(name) {
  return (name||"").trim().toUpperCase().replace(/\s+/g," ");
}
async function loadKnownLenders() {
  try {
    const r = await window.storage.get(LENDER_KNOWN_KEY).catch(()=>null);
    if (!r) return {};
    return JSON.parse(r.value) || {};
  } catch(e) { return {}; }
}
async function loadRejectedLenders() {
  try {
    const r = await window.storage.get(LENDER_REJECTED_KEY).catch(()=>null);
    if (!r) return {};
    return JSON.parse(r.value) || {};
  } catch(e) { return {}; }
}
async function saveKnownLender(name) {
  try {
    const key = _normalizeLender(name);
    if (!key || key.length < 2) return false;
    const known = await loadKnownLenders();
    known[key] = { displayName: name.trim(), confirmedAt: Date.now(), timesSeen: (known[key]?.timesSeen||0)+1 };
    // If we now confirm it, remove from rejected list
    const rejected = await loadRejectedLenders();
    if (rejected[key]) { delete rejected[key]; await window.storage.set(LENDER_REJECTED_KEY, JSON.stringify(rejected)); }
    await window.storage.set(LENDER_KNOWN_KEY, JSON.stringify(known));
    return true;
  } catch(e) { console.error("saveKnownLender error", e); return false; }
}
async function saveRejectedLender(name) {
  try {
    const key = _normalizeLender(name);
    if (!key || key.length < 2) return false;
    const rejected = await loadRejectedLenders();
    rejected[key] = { displayName: name.trim(), rejectedAt: Date.now(), timesRejected: (rejected[key]?.timesRejected||0)+1 };
    // If we reject it, remove from known list
    const known = await loadKnownLenders();
    if (known[key]) { delete known[key]; await window.storage.set(LENDER_KNOWN_KEY, JSON.stringify(known)); }
    await window.storage.set(LENDER_REJECTED_KEY, JSON.stringify(rejected));
    return true;
  } catch(e) { console.error("saveRejectedLender error", e); return false; }
}
// ─── FEATURE 3: MERCHANT HEALTH CHECK (SOS + Google + Website) ────────────────
async function checkMerchantHealth(businessName, state) {
  try {
    const response = await fetch("/api/anthropic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 1500,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        system: "You are a business verification agent for MCA underwriting. You do three things for a merchant: (1) check Secretary of State registration status (active/inactive/delinquent/not found); (2) find Google reviews / business listings (rating, review count, recent sentiment); (3) check if they have a live website. Return only JSON matching the schema.",
        messages: [{
          role: "user",
          content: `Verify this merchant for MCA underwriting:
Business name: "${businessName}"
State: ${state}

Search the web for:
1. "${businessName}" ${state} secretary of state business entity search — is it active and in good standing?
2. "${businessName}" ${state} google reviews — rating, number of reviews, recent complaint themes
3. "${businessName}" website — do they have a working site?

Return ONLY this JSON (no markdown, no preamble):
{
  "sosStatus": "active" | "inactive" | "delinquent" | "not_found" | "unclear",
  "sosDetails": "1-2 sentences on what SOS records show",
  "googleRating": number | null (1-5 scale),
  "googleReviewCount": number | null,
  "reviewSentiment": "positive" | "mixed" | "negative" | "insufficient_data",
  "hasWebsite": true | false | null,
  "websiteUrl": string | null,
  "businessVerified": true | false (overall: does this look like a real operating business?),
  "riskFlags": [ string ] (any red flags — e.g. "dissolved entity", "<3 reviews", "no web presence", "multiple complaints about fraud"),
  "healthScore": "green" | "yellow" | "red",
  "summary": "2-3 sentence plain-English summary for the underwriter"
}`
        }]
      })
    });
    const data = await response.json();
    const text = data.content?.filter(b=>b.type==="text").map(b=>b.text).join("\n") || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch(e) { console.error("checkMerchantHealth error", e); return null; }
}
// ─── FEATURE 9: COMPETING OFFER DETECTOR ──────────────────────────────────────
async function analyzeCompetingOffers(lenderDeposits, mcaPositions, avgMonthly) {
  try {
    const lenderSummary = (lenderDeposits||[]).map(d => `${d.lenderName} +$${d.amount} on ${d.depositDate}`).join("; ");
    const stackSummary = (mcaPositions||[]).map(p => `${p.lenderName} $${p.debitAmount}/${p.frequency}`).join("; ");
    const response = await fetch("/api/anthropic", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: 1800,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        system: "You are a competitive intelligence analyst for MCA lending. You analyze a merchant's history of MCA deposits and active positions to identify which lenders they use, their funding pattern, and El Jay Capital's competitive positioning. You search the web for lender reputation, typical terms, and market intel.",
        messages: [{
          role: "user",
          content: `Analyze this merchant's MCA funding history:

LENDER DEPOSITS DETECTED (money coming in from MCA lenders):
${lenderSummary || "none detected"}

ACTIVE MCA POSITIONS (money going out to lenders):
${stackSummary || "none"}

Avg monthly revenue: $${avgMonthly?.toLocaleString() || "unknown"}

Search the web for reputation/typical terms of each unique lender named above, then return ONLY this JSON:
{
  "lendersIdentified": [ { "name": string, "typicalFactor": string, "reputation": string, "notes": string } ],
  "totalFundingHistory": "estimate of how much this merchant has taken in MCA advances total, based on deposits",
  "refinancingPattern": "description of how often they refinance / stack (e.g. 'serial stacker, refinances every 60 days')",
  "competitiveAdvantages": [ string ] (where El Jay wins vs these lenders),
  "competitiveRisks": [ string ] (risks of funding a merchant who uses these lenders — e.g. 'known for aggressive collections', 'might refi away quickly'),
  "recommendedPositioning": "1-2 sentences on how El Jay should position terms to win this deal",
  "estimatedRemainingObligations": "rough estimate of outstanding balance on their MCA stack",
  "summary": "2-3 sentence overview for the underwriter"
}`
        }]
      })
    });
    const data = await response.json();
    const text = data.content?.filter(b=>b.type==="text").map(b=>b.text).join("\n") || "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    return JSON.parse(jsonMatch[0]);
  } catch(e) { console.error("analyzeCompetingOffers error", e); return null; }
}
// ─── FEATURE 10: MISSED PAYMENT TRACKER ───────────────────────────────────────
async function addMissedPayment(dealId, note) {
  try {
    const r = await window.storage.get(dealId);
    if (!r) return false;
    const deal = JSON.parse(r.value);
    deal.missedPayments = [...(deal.missedPayments||[]), { date: new Date().toISOString(), note: note || "Payment missed" }];
    await window.storage.set(dealId, JSON.stringify(deal));
    if (typeof Notification !== "undefined" && Notification.permission === "granted") {
      new Notification("El Jay Capital — Missed Payment", {
        body: `${deal.businessName}: ${note || "Payment missed"}`,
        icon: "/favicon.ico"
      });
    }
    return true;
  } catch(e) { console.error("addMissedPayment error", e); return false; }
}
// ─── AI STATEMENT ANALYZER ────────────────────────────────────────────────────
async function analyzeStatements(files, lenderContext) {
  const fileContents = await Promise.all(files.map(f => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve({ name: f.name, type: f.type, data: e.target.result.split(",")[1] });
    reader.onerror = reject;
    reader.readAsDataURL(f);
  })));
  const isImage = (type) => type.startsWith("image/");
  const isPDF = (type) => type === "application/pdf";
  const contentBlocks = fileContents.map(fc => {
    if (isPDF(fc.type)) {
      return { type:"document", source:{ type:"base64", media_type:"application/pdf", data:fc.data }, title: fc.name };
    } else if (isImage(fc.type)) {
      return { type:"image", source:{ type:"base64", media_type:fc.type, data:fc.data } };
    }
    return null;
  }).filter(Boolean);
  contentBlocks.push({
    type:"text",
    text:`You are an elite MCA underwriting AI. Your job is to outperform human underwriters by detecting patterns, not just totals. Analyze these bank statements with the depth of a forensic accountant. Return ONLY a raw JSON object — no markdown, no backticks, no explanation.
{
  "businessName": string,
  "monthsAnalyzed": number,
  "bankIntelligence": {
    "avgDailyBalance": number (true average of daily ending balance across all days),
    "lowestDailyBalance": number (single lowest daily balance seen — can be negative),
    "highestDailyBalance": number,
    "depositFrequency": "daily" | "weekly" | "sporadic" (how often deposits hit),
    "depositSources": number (count of distinct deposit originators/companies),
    "topSourcePct": number (% of total deposits from the single largest source — 0-100),
    "topSourceName": string (name of that largest deposit source),
    "cashWithdrawPct": number (cash/ATM withdrawals as % of total outflows — 0-100),
    "avgEndOfDayBalance": number
  },
  "revenueQuality": {
    "avgMonthly": number (avg monthly deposits — all months),
    "mo3avg": number (most recent 3 months avg),
    "mo6avg": number (most recent 6 months avg — use avgMonthly if <6 months),
    "mo12avg": number (12 month avg — use avgMonthly if less data),
    "lowestMonth": number,
    "highestMonth": number,
    "revTrend": "up" | "down" | "flat" | "volatile" (overall direction of monthly deposits),
    "revVolatility": "low" | "medium" | "high" (how much month-to-month swings),
    "depositCount": number (avg deposits per month)
  },
  "nsfAnalysis": {
    "nsf30": number (NSF/returned items in most recent 30 days),
    "nsf60": number (NSF in most recent 60 days),
    "nsf90": number (NSF in most recent 90 days),
    "nsfs": number (average per month overall),
    "negativeDays": number (avg days per month where balance was negative or zero),
    "nsfTrend": "improving" | "worsening" | "stable"
  },
  "monthlyBreakdown": [
    { "month": "Jan 2025", "deposits": 45000, "withdrawals": 38000, "endingBalance": 7200, "nsfs": 1, "negativeDays": 0 }
  ],
  "mcaPositions": [
    {
      "lenderName": string (exact name from ACH description),
      "debitAmount": number (per-occurrence amount),
      "frequency": "daily" | "weekly",
      "debitsPerMonth": number,
      "totalMonthlyBurden": number,
      "firstSeen": string,
      "lastSeen": string,
      "estimatedRemainingBalance": number,
      "confidence": "high" | "medium" | "low"
    }
  ],
  "totalMonthlyMcaBurden": number,
  "estimatedTotalMcaBalance": number,
  "patterns": {
    "payrollCycle": boolean (true if you see regular large outflows consistent with payroll — biweekly/weekly large debits to payroll companies or many same-day small deposits in),
    "seasonality": boolean (true if revenue shows clear seasonal peaks/troughs across months),
    "weekendDips": boolean (true if balance consistently lower on Mon/Tue suggesting weekend cash drain),
    "weekdayStrength": boolean (true if deposits cluster heavily Mon-Fri),
    "rapidMcaPayoffHistory": boolean (true if you see multiple MCA positions that each only lasted 1-2 months before disappearing — serial refinancing),
    "multiLenderBankPulls": boolean (true if you see multiple different companies pulling bank verification or soft pulls in the statement),
    "ownerTransfersIncreasing": boolean (true if transfers labeled as owner draws, personal accounts, or Zelle/Venmo to individuals are growing over time),
    "cashWithdrawalSpike": boolean (true if cash/ATM withdrawals are notably higher in recent months vs earlier months),
    "roundNumberDeposits": boolean (true if a large % of deposits are suspiciously round numbers like $5000, $10000, $15000 — possible unreported income staging)
  },
  "lenderDeposits": [
    {
      "lenderName": string (exact name from the deposit/credit description),
      "depositDate": string (e.g. "Mar 15, 2025"),
      "amount": number,
      "description": string (the raw ACH/wire description from the statement),
      "type": "MCA_FUNDING" | "LOAN_PROCEEDS" | "LINE_OF_CREDIT" | "OTHER_LENDER"
    }
  ],
  "aiVerdict": string (2-3 sentence underwriter narrative summarizing the biggest risks AND strengths — be specific with numbers. Note if Zelle or transfers were excluded from revenue and by how much if significant),
  "notes": string (any other important observations)
}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CRITICAL RULES:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
LENDER DEPOSIT DETECTION (critical for stacking intelligence):
- Scan ALL credits/deposits for any that appear to be funding from a lender, MCA company, or financial institution
- Signals: large lump-sum credits labeled with a finance company name, "ADVANCE", "FUNDING", "LOAN", "PROCEEDS", "DISBURSEMENT", wire transfers from known MCA/lender names
- Known lender names to watch: same list as MCA detection above PLUS: Kabbage, OnDeck, BlueVine, Fundbox, Square Capital, PayPal Working Capital, Amazon Lending, Shopify Capital, Stripe Capital, Clearco, Behalf, Credibly, National Funding, Lendio, Biz2Credit, SmartBiz, Funding Circle, SBA loan, bank line of credit
- Include ALL detected lender deposits — even if they appear to be refinances or payoffs of prior positions
- If a large round-number deposit appears from a finance company, include it even if you're not 100% certain — set type to "OTHER_LENDER"
- DO NOT include regular business revenue, customer payments, or ACH credits from non-lender sources
MCA DETECTION (highest priority):
- Recurring same-amount ACH debits pulling Mon-Fri daily or weekly = MCA payment. Daily MCA ACH pulls 5 days a week (Monday–Friday only, NOT weekends) — approximately 22 debits per month. Use this when estimating debitsPerMonth and totalMonthlyBurden.
- Known MCA names: Rapid Finance, Greenbox, Fundbox, OnDeck, Kabbage, BlueVine, Credibly, Libertas, Kapitus, Expansion Capital, Bizfund, Pearl Capital, Fox Business, SLR, Cloudfund, IOU Financial, Reliant Funding, Mulligan Funding, Forward Financing, Idea Financial, National Funding, Headway Capital, Lendio, Kapital, Pirs Capital, Cloudfund, BRT Analytics, Mantis Funding, 1st Global — but ANY consistent same-amount daily/weekly pull is an MCA until proven otherwise
- ACH descriptions containing "PPD", "CCD", "WEB", "PREAUTH" + a finance company name = MCA
- Do NOT flag: payroll processors (ADP, Gusto, Paychex), utilities, insurance, rent, loan payments with irregular amounts
REVENUE QUALITY:
- Revenue = deposits that represent actual business income ONLY
- EXCLUDE from revenue (do NOT count toward monthly deposits or averages):
  * Zelle payments of any kind — personal, business, or otherwise
  * Bank transfers (internal transfers, account-to-account, wire transfers between own accounts)
  * ACH transfers labeled "TRANSFER", "XFER", "ACCT TRANSFER", "ONLINE TRANSFER"
  * Owner/personal deposits or draws coming back in
  * Loan proceeds, MCA funding deposits, line of credit draws (already captured in lenderDeposits)
  * Round-number cash deposits that look staged ($5,000 / $10,000 / $15,000 exact)
  * Refunds, chargebacks reversals, or one-time anomaly credits
  * Any credit labeled "ZELLE", "ZELLEPAY", "ZLR*", "ZELLE FROM", "ZELLE PAYMENT"
  * Any credit labeled "TRANSFER FROM", "TRANSFER IN", "ACH TRANSFER", "BOOK TRANSFER", "MEMO TRANSFER"
- If a deposit is ambiguous (could be business revenue OR transfer), EXCLUDE it and note it in "notes"
- Be conservative: when in doubt, leave it out of revenue
- Revenue sources TO include: card processing settlements (Visa/MC/Amex/Discover/Square/Stripe/Toast/Clover), ACH credits from identifiable business customers or platforms, cash deposits that reflect sales patterns, PayPal business payments, invoice payments from business clients
PATTERN DETECTION:
- Look at the sequence and timing of transactions, not just totals
- Payroll detection: multiple same-day credits of similar small amounts (tip/hourly workers) OR large biweekly ADP/Gusto debits
- Seasonality: compare Jan-Mar vs Jun-Aug — flag if any month is >40% higher than another
If you cannot determine a value with reasonable confidence, use 0 for numbers and false for booleans. Never guess wildly.
${lenderContext?.known?.length > 0 ? `\nEL JAY'S LENDER MEMORY — names confirmed as REAL MCA lenders on prior deals (use these as high-confidence if you see them):\n${lenderContext.known.map(n=>`• ${n}`).join("\n")}` : ""}
${lenderContext?.rejected?.length > 0 ? `\nEL JAY'S REJECTED LIST — names the underwriter has previously flagged as NOT actual MCA lenders. Do NOT label these as mcaPositions or lenderDeposits even if they look like funding events:\n${lenderContext.rejected.map(n=>`• ${n}`).join("\n")}` : ""}`
  });
  const response = await fetch("/api/anthropic", {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body: JSON.stringify({
      model:"claude-sonnet-4-6",
      max_tokens:3000,
      messages:[{ role:"user", content:contentBlocks }]
    })
  });
  const data = await response.json();
  const text = data.content?.find(b=>b.type==="text")?.text || "";
  const clean = text.replace(/```json|```/g,"").trim();
  return JSON.parse(clean);
}
// ─── DESIGN TOKENS ────────────────────────────────────────────────────────────
const C = {
  bg:"#0c0c0c", card:"#111", card2:"#141414", border:"#222", border2:"#1a1a1a",
  accent:"#c8000a", gold:"#c8a040", white:"#f0ede8", muted:"#555", text:"#c8c5c0",
  green:"#18a058", amber:"#d08020", blue:"#4878c0", red:"#c8000a",
};
const inp = {
  width:"100%", background:"#0a0a0a", border:`1px solid ${C.border}`,
  borderRadius:7, color:C.white, fontSize:13, padding:"9px 12px",
  outline:"none", boxSizing:"border-box", fontFamily:"'IBM Plex Mono',monospace",
};
const sel = {...inp, cursor:"pointer"};
const Fld = ({label,hint,children,highlight}) => (
  <div style={{position:"relative"}}>
    <label style={{display:"block",fontSize:9,fontWeight:700,letterSpacing:"0.14em",color:highlight?C.gold:C.muted,textTransform:"uppercase",marginBottom:4}}>
      {label}{highlight&&<span style={{marginLeft:6,fontSize:8,color:C.gold,background:"rgba(200,160,64,0.12)",padding:"1px 5px",borderRadius:3}}>AI FILLED</span>}
    </label>
    {children}
    {hint&&<p style={{fontSize:10,color:"#383838",marginTop:2}}>{hint}</p>}
  </div>
);
const Toggle = ({label,value,onChange,warn}) => (
  <div style={{display:"flex",alignItems:"center",gap:9}}>
    <div onClick={()=>onChange(!value)} style={{width:38,height:20,background:value?(warn?C.red:C.green):"#1a1a1a",borderRadius:10,cursor:"pointer",position:"relative",transition:"background 0.2s",border:`1px solid ${value?(warn?C.red:C.green):"#2a2a2a"}`}}>
      <div style={{position:"absolute",top:2,left:value?19:2,width:14,height:14,borderRadius:"50%",background:"#fff",transition:"left 0.2s"}}/>
    </div>
    <span style={{fontSize:12,color:value?(warn?C.red:C.white):C.muted}}>{label}</span>
  </div>
);
function ScoreBar({label,earned,max,detail}) {
  const pct=earned/max;
  const c=pct>=0.75?C.green:pct>=0.5?C.amber:C.red;
  return (
    <div style={{marginBottom:14}}>
      <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
        <span style={{fontSize:12,color:C.text}}>{label}</span>
        <span style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:11,fontWeight:700,color:c}}>{earned}/{max}</span>
      </div>
      <div style={{background:"#1a1a1a",borderRadius:3,height:5,overflow:"hidden",marginBottom:3}}>
        <div style={{width:`${pct*100}%`,height:"100%",background:c,borderRadius:3,transition:"width 0.9s cubic-bezier(.4,0,.2,1)"}}/>
      </div>
      <div style={{fontSize:10,color:C.muted}}>{detail}</div>
    </div>
  );
}
const StatBox = ({label,value,sub,color}) => (
  <div style={{background:"#0a0a0a",border:`1px solid ${C.border}`,borderRadius:9,padding:"13px 11px",textAlign:"center"}}>
    <div style={{fontSize:8.5,color:C.muted,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:5}}>{label}</div>
    <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:16,fontWeight:700,color:color||C.white}}>{value}</div>
    {sub&&<div style={{fontSize:9,color:C.muted,marginTop:2}}>{sub}</div>}
  </div>
);
function ChatBubble({msg}) {
  const [exp, setExp] = useState({});
  const tog = k => setExp(p=>({...p,[k]:!p[k]}));
  const isUser = msg.role==="user";
  return (
    <div style={{alignSelf:isUser?"flex-end":"flex-start",maxWidth:"90%",display:"flex",flexDirection:"column",gap:4}}>
      {!isUser&&msg.muscleResults&&Object.keys(msg.muscleResults).length>0&&(
        <div style={{display:"flex",flexDirection:"column",gap:4}}>
          {msg.muscleResults.gemini&&(
            <div style={{background:"rgba(66,133,244,0.05)",border:"1px solid rgba(66,133,244,0.18)",borderRadius:7,overflow:"hidden"}}>
              <div onClick={()=>tog("gemini")} style={{display:"flex",alignItems:"center",gap:7,padding:"6px 10px",cursor:"pointer"}}>
                <span style={{fontSize:11}}>🌐</span>
                <span style={{fontSize:8,fontWeight:700,color:"#4285f4",letterSpacing:"0.1em",flex:1}}>GEMINI WEB RESULT</span>
                <span style={{fontSize:9,color:C.muted}}>{exp.gemini?"▲":"▼"}</span>
              </div>
              {exp.gemini&&<div style={{padding:"0 10px 10px",fontSize:10.5,color:"#8090a8",lineHeight:1.6,whiteSpace:"pre-wrap",borderTop:"1px solid rgba(66,133,244,0.1)"}}>{msg.muscleResults.gemini}</div>}
            </div>
          )}
          {msg.muscleResults.grok&&(
            <div style={{background:"rgba(29,155,240,0.05)",border:"1px solid rgba(29,155,240,0.18)",borderRadius:7,overflow:"hidden"}}>
              <div onClick={()=>tog("grok")} style={{display:"flex",alignItems:"center",gap:7,padding:"6px 10px",cursor:"pointer"}}>
                <span style={{fontSize:11}}>⚡</span>
                <span style={{fontSize:8,fontWeight:700,color:"#1d9bf0",letterSpacing:"0.1em",flex:1}}>GROK SOCIAL INTEL</span>
                <span style={{fontSize:9,color:C.muted}}>{exp.grok?"▲":"▼"}</span>
              </div>
              {exp.grok&&<div style={{padding:"0 10px 10px",fontSize:10.5,color:"#6090a8",lineHeight:1.6,whiteSpace:"pre-wrap",borderTop:"1px solid rgba(29,155,240,0.1)"}}>{msg.muscleResults.grok}</div>}
            </div>
          )}
        </div>
      )}
      <div style={{background:isUser?"#1a1a30":"#0f0f18",border:`1px solid ${isUser?"#2a2a50":"#1a1a2e"}`,borderRadius:isUser?"10px 10px 2px 10px":"10px 10px 10px 2px",padding:"10px 13px"}}>
        {!isUser&&(
          <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:5}}>
            <span style={{fontSize:8,color:"#5060c0",letterSpacing:"0.1em",textTransform:"uppercase",fontWeight:700}}>🧠 OPUS ADVISOR</span>
            {msg.musclesUsed?.length>0&&<span style={{fontSize:8,color:"#303050"}}>via {msg.musclesUsed.map(m=>m==="gemini"?"🌐":m==="grok"?"⚡":m).join(" + ")}</span>}
          </div>
        )}
        <div style={{fontSize:12,color:isUser?"#a0a8e0":C.text,lineHeight:1.65,whiteSpace:"pre-wrap"}}>{msg.content}</div>
      </div>
    </div>
  );
}
// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [view, setView] = useState("upload"); // upload | form | result | memory
  const [res, setRes] = useState(null);
  const [uploadedFiles, setUploadedFiles] = useState([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisData, setAnalysisData] = useState(null);
  const [analysisError, setAnalysisError] = useState(null);
  const [aiFilledFields, setAiFilledFields] = useState({});
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef();
  // Deal memory state
  const [allDeals, setAllDeals] = useState([]);
  const [dealStats, setDealStats] = useState(null);
  const [patternInsights, setPatternInsights] = useState(null);
  const [loadingInsights, setLoadingInsights] = useState(false);
  const [savingDeal, setSavingDeal] = useState(false);
  const [dealSaved, setDealSaved] = useState(false);
  const [savedDealId, setSavedDealId] = useState(null);
  const [fundingChannel, setFundingChannel] = useState("iso");
  const [outcomeModal, setOutcomeModal] = useState(null); // {dealId, businessName}
  const [outcomeForm, setOutcomeForm] = useState({outcome:"", notes:""});
  const [updatingOutcome, setUpdatingOutcome] = useState(false);
  // Deal chat state
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatStage, setChatStage] = useState(null); // routing | gemini | grok | thinking
  const chatEndRef = useRef(null);
  // FEATURE 3: merchant health check
  const [merchantHealth, setMerchantHealth] = useState(null);
  const [checkingHealth, setCheckingHealth] = useState(false);
  // FEATURE 8: offer letter modal
  const [showOfferLetter, setShowOfferLetter] = useState(false);
  // FEATURE 9: competing offer analysis
  const [competingOffers, setCompetingOffers] = useState(null);
  const [analyzingCompeting, setAnalyzingCompeting] = useState(false);
  // FEATURE 10: missed payment tracking
  const [missedPaymentModal, setMissedPaymentModal] = useState(null); // {dealId, businessName}
  const [missedPaymentNote, setMissedPaymentNote] = useState("");
  const [recordingMissed, setRecordingMissed] = useState(false);
  // LENDER MEMORY
  const [knownLenders, setKnownLenders] = useState({});    // { normalizedKey: {displayName, confirmedAt, timesSeen} }
  const [rejectedLenders, setRejectedLenders] = useState({});
  const [f, setF] = useState({
    businessName:"", state:"", industry:"Retail",
    avgMonthly:"", lowestMonth:"", depositCount:"",
    nsfs:"", negativeDays:"", existingBalance:"",
    timeInBusiness:"", creditScore:"",
    requestedAmount:"", position:"2nd",
    mcaHistory:true, priorDefault:false,
  });
  const s = (k,v) => setF(p=>({...p,[k]:v}));
  const handleFiles = useCallback((newFiles) => {
    const valid = Array.from(newFiles).filter(f =>
      f.type==="application/pdf" || f.type.startsWith("image/")
    );
    setUploadedFiles(prev => [...prev, ...valid].slice(0,6));
  }, []);
  const onDrop = useCallback((e) => {
    e.preventDefault(); setDragOver(false);
    handleFiles(e.dataTransfer.files);
  }, [handleFiles]);
  // Load deal memory + lender memory on mount
  useEffect(() => {
    (async () => {
      const [deals, stats, known, rejected] = await Promise.all([
        loadAllDeals(), loadStats(), loadKnownLenders(), loadRejectedLenders()
      ]);
      setAllDeals(deals);
      setDealStats(stats);
      setKnownLenders(known);
      setRejectedLenders(rejected);
    })();
    // FEATURE 10: request notification permission for missed payment alerts
    if (typeof Notification !== "undefined" && Notification.permission === "default") {
      Notification.requestPermission();
    }
  }, []);
  // Lender memory helpers wired to state
  const confirmLender = async (name) => {
    const ok = await saveKnownLender(name);
    if (ok) setKnownLenders(await loadKnownLenders());
    setRejectedLenders(await loadRejectedLenders());
  };
  const rejectLender = async (name) => {
    const ok = await saveRejectedLender(name);
    if (ok) setRejectedLenders(await loadRejectedLenders());
    setKnownLenders(await loadKnownLenders());
  };
  const handleSaveDeal = async () => {
    if (!res || dealSaved) return;
    setSavingDeal(true);
    const dealRecord = {
      id: `deal:${Date.now()}`,
      timestamp: Date.now(),
      dateStr: new Date().toLocaleDateString("en-US",{month:"short",day:"numeric",year:"numeric"}),
      businessName: f.businessName||"Unknown",
      industry: f.industry,
      state: f.state,
      score: res.totalScore,
      decision: res.decision,
      advanceAmount: res.approvedAdvance,
      factorRate: res.factorRate,
      termDays: res.termDays,
      avgMonthly: +f.avgMonthly||0,
      revTrend: f.revTrend||"flat",
      revVolatility: f.revVolatility||"low",
      position: f.position,
      numMcaPositions: (res.mcaPositions||[]).length,
      burdenPct: res.burdenPct||0,
      avgDailyBalance: +f.avgDailyBalance||0,
      nsf90: +f.nsf90||0,
      timeInBusiness: +f.timeInBusiness||0,
      creditScore: +f.creditScore||0,
      channel: fundingChannel,
      outcome: "funded",
      outcomeNotes: "",
      fraudSignalCount: (res.fraudSignals||[]).filter(s=>s.level==="high").length,
      missedPayments: [], // FEATURE 10
    };
    const id = await saveDeal(dealRecord);
    if (id) {
      setSavedDealId(id);
      setDealSaved(true);
      const [deals, stats] = await Promise.all([loadAllDeals(), loadStats()]);
      setAllDeals(deals);
      setDealStats(stats);
      // Load pattern insights with new deal included
      setLoadingInsights(true);
      const insights = await getPatternInsights({...dealRecord, mcaPositions:res.mcaPositions||[]}, deals);
      setPatternInsights(insights);
      setLoadingInsights(false);
    }
    setSavingDeal(false);
  };
  const handleUpdateOutcome = async () => {
    if (!outcomeModal||!outcomeForm.outcome) return;
    setUpdatingOutcome(true);
    await updateDealOutcome(outcomeModal.dealId, outcomeForm.outcome, outcomeForm.notes);
    const [deals, stats] = await Promise.all([loadAllDeals(), loadStats()]);
    setAllDeals(deals);
    setDealStats(stats);
    setOutcomeModal(null);
    setOutcomeForm({outcome:"",notes:""});
    setUpdatingOutcome(false);
  };
  const loadMemoryView = async () => {
    setView("memory");
    const [deals, stats] = await Promise.all([loadAllDeals(), loadStats()]);
    setAllDeals(deals);
    setDealStats(stats);
  };
  const sendChatMessage = async () => {
    if (!chatInput.trim() || chatLoading) return;
    const userMsg = chatInput.trim();
    setChatInput("");
    const newMessages = [...chatMessages, {role:"user", content:userMsg}];
    setChatMessages(newMessages);
    setChatLoading(true);
    setChatStage("routing");
    const dealContext = res ? `
DEAL SUMMARY:
- Business: ${f.businessName||"Unknown"}, Industry: ${f.industry}, State: ${f.state}
- Score: ${res.totalScore}/90 (${res.riskBand}), Decision: ${res.decision}
- Approved Advance: $${res.approvedAdvance?.toLocaleString()}, Factor: ${res.factorRate}x, Term: ${res.termDays}d
- Daily Payment: $${res.dailyPayment?.toLocaleString()} (ACH Mon-Fri only, 22x/mo — NOT 7 days)
- Avg Monthly Revenue: $${(+f.avgMonthly||0).toLocaleString()}, Trend: ${f.revTrend||"flat"}, Volatility: ${f.revVolatility||"low"}
- Avg Daily Balance: $${(+f.avgDailyBalance||0).toLocaleString()}, Lowest: $${(+f.lowestDailyBalance||0).toLocaleString()}
- NSF (90d): ${f.nsf90||0}, Negative Days/Mo: ${f.negativeDays||0}
- Position: ${f.position}, Active MCAs: ${(f.mcaPositions||[]).length}
- MCA Burden: $${res.totalMonthlyMcaBurden?.toLocaleString()}/mo (${Math.round((res.burdenPct||0)*100)}% of revenue)
- TIB: ${f.timeInBusiness||0}mo, FICO: ${f.creditScore||"N/A"}
- Key Risk Drivers: ${res.riskProfile?.keyRiskDrivers?.join(", ")||"none"}
- Flags: ${res.flags?.join(" | ")||"none"}
- Stips: ${res.stips?.join(" | ")||"none"}
- Protective Conditions: ${res.protectiveConditions?.join(" | ")||"none"}
- 10-Day Miss Test: ${res.cashFlowSafety?.stressTestResult}
- Safe Daily Payment: $${res.cashFlowSafety?.safeDailyPayment?.toLocaleString()}
- Fraud Signals: ${res.fraudSignals?.map(s=>`[${s.level}] ${s.msg}`).join(" | ")||"none"}
- AI Verdict: ${analysisData?.aiVerdict||"N/A"}
${(f.mcaPositions||[]).length>0?`- MCA Stack: ${(f.mcaPositions||[]).map(p=>`${p.lenderName} $${p.debitAmount}/${p.frequency} ($${p.totalMonthlyBurden}/mo)`).join(", ")}`:""}
${analysisData?.lenderDeposits?.length>0?`- Lender Deposits: ${analysisData.lenderDeposits.map(d=>`${d.lenderName} +$${d.amount} on ${d.depositDate}`).join(", ")}`:""}
` : "No deal underwritten yet.";
    const callGemini = async (q) => {
      try {
        const r = await fetch("/api/anthropic", {
          method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({
            model:"claude-opus-4-6", max_tokens:1000,
            tools:[{type:"web_search_20250305",name:"web_search"}],
            system:"You are a financial research assistant specializing in MCA lending. Search the web and return specific, data-driven findings relevant to MCA underwriting decisions.",
            messages:[{role:"user", content:`Search the web and research: ${q}`}]
          })
        });
        const d = await r.json();
        if (d.error) { console.warn("Gemini muscle API error:", d.error); return ""; }
        return d.content?.filter(b=>b.type==="text").map(b=>b.text).join("\n") || "";
      } catch(e) { console.warn("Gemini muscle exception:", e); return ""; }
    };
    const callGrok = async (q) => {
      try {
        const r = await fetch("/api/anthropic", {
          method:"POST", headers:{"Content-Type":"application/json"},
          body: JSON.stringify({
            model:"claude-opus-4-6", max_tokens:800,
            tools:[{type:"web_search_20250305",name:"web_search"}],
            system:"You are a social intelligence analyst focused on finance and lending. Search for current discussions, sentiment, and trending topics related to MCA lending, small business, and financial industry.",
            messages:[{role:"user", content:`Search for current social sentiment and trending discussions about: ${q}`}]
          })
        });
        const d = await r.json();
        if (d.error) { console.warn("Grok muscle API error:", d.error); return ""; }
        return d.content?.filter(b=>b.type==="text").map(b=>b.text).join("\n") || "";
      } catch(e) { console.warn("Grok muscle exception:", e); return ""; }
    };
    try {
      // Step 1 — Route: decide which muscles to activate
      const routeRes = await fetch("/api/anthropic", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          model:"claude-opus-4-6", max_tokens:200,
          system:`You are a query router for an MCA underwriting deal advisor. Return ONLY raw JSON — no markdown.
{"gemini":true/false,"grok":true/false,"geminiQuery":"query","grokQuery":"query"}
- gemini: true if the question needs external market data, industry stats, lender info, or research
- grok: true if the question is about current trends, what lenders are doing, social sentiment, market moves
- Most deal-specific questions (structure, stips, risk) need NO external muscles — answer from deal context`,
          messages:[{role:"user", content:`Deal context available: YES\nUser question: ${userMsg}`}]
        })
      });
      const routeData = await routeRes.json();
      let route = {gemini:false, grok:false};
      try { route = JSON.parse((routeData.content?.find(b=>b.type==="text")?.text||"{}").replace(/```json|```/g,"").trim()); } catch{}
      // Step 2 — Fire muscles
      const muscleResults = {};
      if (route.gemini) {
        setChatStage("gemini");
        muscleResults.gemini = await callGemini(route.geminiQuery||userMsg);
      }
      if (route.grok) {
        setChatStage("grok");
        muscleResults.grok = await callGrok(route.grokQuery||userMsg);
      }
      // Step 3 — Opus Brain synthesizes
      setChatStage("thinking");
      const muscleContext = [
        muscleResults.gemini ? `🌐 WEB RESEARCH (Gemini):\n${muscleResults.gemini}` : "",
        muscleResults.grok   ? `⚡ SOCIAL INTEL (Grok):\n${muscleResults.grok}` : "",
      ].filter(Boolean).join("\n\n");
      const response = await fetch("/api/anthropic", {
        method:"POST", headers:{"Content-Type":"application/json"},
        body: JSON.stringify({
          model:"claude-opus-4-6", max_tokens:1200,
          system:`You are El Jay Capital's deal advisor — powered by Opus, the most capable reasoning model. You have deep MCA underwriting expertise and access to real-time intelligence from your muscles.
CRITICAL ACH RULE: Daily ACH pulls Monday–Friday ONLY — 5 days/week, ~22 business days/month. Never 7 days. A $500/day payment = $2,500/week, $11,000/month.
${muscleContext ? `MUSCLE INTELLIGENCE GATHERED:\n${muscleContext}\n\nUse this data to enrich your answer. Don't just quote it — synthesize it with your deal knowledge.` : ""}
CURRENT DEAL:
${dealContext}
Be direct, specific, use actual numbers. Talk like a senior underwriter colleague — no fluff, real opinions. Concise but complete.`,
          messages: newMessages.map(m=>({role:m.role, content:m.content}))
        })
      });
      const data = await response.json();
      // Surface the real failure instead of a generic placeholder
      let reply = data.content?.find(b=>b.type==="text")?.text;
      if (!reply) {
        if (data.error) {
          reply = `API error: ${data.error.type || "unknown"} — ${data.error.message || JSON.stringify(data.error)}`;
        } else if (data.type === "error") {
          reply = `API error: ${data.message || JSON.stringify(data)}`;
        } else {
          reply = `No text content returned. Raw response: ${JSON.stringify(data).slice(0,800)}`;
        }
        console.error("Deal advisor empty response:", data);
      }
      const musclesUsed = Object.keys(muscleResults);
      setChatMessages(prev=>[...prev, {role:"assistant", content:reply, musclesUsed, muscleResults}]);
    } catch(e) {
      console.error("Deal advisor exception:", e);
      setChatMessages(prev=>[...prev, {role:"assistant", content:`Error: ${e.message}`, musclesUsed:[], muscleResults:{}}]);
    }
    setChatLoading(false);
    setChatStage(null);
    setTimeout(()=>chatEndRef.current?.scrollIntoView({behavior:"smooth"}), 100);
  };
  const runAnalysis = async () => {
    if (!uploadedFiles.length) return;
    setAnalyzing(true); setAnalysisError(null);
    try {
      // Pass lender memory so AI respects confirmed/rejected names
      const lenderContext = {
        known: Object.values(knownLenders).map(l => l.displayName),
        rejected: Object.values(rejectedLenders).map(l => l.displayName),
      };
      const data = await analyzeStatements(uploadedFiles, lenderContext);
      setAnalysisData(data);
      const filled = {};
      const updates = {};
      const bi = data.bankIntelligence||{};
      const rq = data.revenueQuality||{};
      const nf = data.nsfAnalysis||{};
      const pt = data.patterns||{};
      if (data.businessName?.trim()) { updates.businessName=data.businessName; filled.businessName=true; }
      if (rq.avgMonthly>0) { updates.avgMonthly=String(Math.round(rq.avgMonthly)); filled.avgMonthly=true; }
      if (rq.lowestMonth>0) { updates.lowestMonth=String(Math.round(rq.lowestMonth)); filled.lowestMonth=true; }
      if (rq.depositCount>0) { updates.depositCount=String(Math.round(rq.depositCount)); filled.depositCount=true; }
      if (nf.nsfs>=0) { updates.nsfs=String(Math.round(nf.nsfs)); filled.nsfs=true; }
      if (nf.negativeDays>=0) { updates.negativeDays=String(Math.round(nf.negativeDays)); filled.negativeDays=true; }
      if (data.estimatedTotalMcaBalance>0) { updates.existingBalance=String(Math.round(data.estimatedTotalMcaBalance)); filled.existingBalance=true; }
      if (data.totalMonthlyMcaBurden>0) { updates.totalMonthlyMcaBurden=data.totalMonthlyMcaBurden; filled.totalMonthlyMcaBurden=true; }
      if (data.mcaPositions?.length>0) { updates.mcaPositions=data.mcaPositions; filled.mcaPositions=true; }
      // Bank intelligence fields
      updates.avgDailyBalance = bi.avgDailyBalance||0;
      updates.lowestDailyBalance = bi.lowestDailyBalance||0;
      updates.depositFrequency = bi.depositFrequency||"unknown";
      updates.depositSources = bi.depositSources||1;
      updates.topSourcePct = bi.topSourcePct||0;
      updates.cashWithdrawPct = bi.cashWithdrawPct||0;
      // Revenue quality fields
      updates.mo3avg = rq.mo3avg||0;
      updates.mo6avg = rq.mo6avg||0;
      updates.mo12avg = rq.mo12avg||0;
      updates.revTrend = rq.revTrend||"flat";
      updates.revVolatility = rq.revVolatility||"low";
      // NSF fields
      updates.nsf30 = nf.nsf30||0;
      updates.nsf60 = nf.nsf60||0;
      updates.nsf90 = nf.nsf90||0;
      // Patterns
      updates.patterns = pt;
      setF(prev=>({...prev,...updates}));
      setAiFilledFields(filled);
      setView("form");
    } catch(err) {
      setAnalysisError("Could not parse the statement(s). Please check the file and try again, or enter values manually.");
      console.error(err);
    }
    setAnalyzing(false);
  };
  const submit = () => {
    const d={
      ...f,
      avgMonthly:+f.avgMonthly||0, lowestMonth:+f.lowestMonth||0, depositCount:+f.depositCount||0,
      nsfs:+f.nsfs||0, negativeDays:+f.negativeDays||0, existingBalance:+f.existingBalance||0,
      timeInBusiness:+f.timeInBusiness||0, creditScore:+f.creditScore||0, requestedAmount:+f.requestedAmount||0,
      mcaPositions:f.mcaPositions||[], totalMonthlyMcaBurden:+f.totalMonthlyMcaBurden||0,
      avgDailyBalance:+f.avgDailyBalance||0, lowestDailyBalance:+f.lowestDailyBalance||0,
      depositFrequency:f.depositFrequency||"unknown", depositSources:+f.depositSources||1,
      topSourcePct:+f.topSourcePct||0, cashWithdrawPct:+f.cashWithdrawPct||0,
      mo3avg:+f.mo3avg||0, mo6avg:+f.mo6avg||0, mo12avg:+f.mo12avg||0,
      revTrend:f.revTrend||"flat", revVolatility:f.revVolatility||"low",
      nsf30:+f.nsf30||0, nsf60:+f.nsf60||0, nsf90:+f.nsf90||0,
      patterns:f.patterns||{}
    };
    setRes(underwrite(d)); setDealSaved(false); setSavedDealId(null); setPatternInsights(null); setChatMessages([]);
    setCompetingOffers(null); setShowOfferLetter(false); // reset per-deal feature state
    // LENDER MEMORY: on submit, any non-empty lender name the user kept is a confirmation
    (async () => {
      for (const pos of (f.mcaPositions||[])) {
        if (pos.lenderName && pos.lenderName.trim().length >= 2) {
          await saveKnownLender(pos.lenderName);
        }
      }
      setKnownLenders(await loadKnownLenders());
    })();
    setView("result");
  };
  // FEATURE 3 handler
  const handleCheckHealth = async () => {
    if (!f.businessName || !f.state) return;
    setCheckingHealth(true);
    setMerchantHealth(null);
    const result = await checkMerchantHealth(f.businessName, f.state);
    setMerchantHealth(result);
    setCheckingHealth(false);
  };
  // FEATURE 9 handler
  const handleAnalyzeCompeting = async () => {
    setAnalyzingCompeting(true);
    const result = await analyzeCompetingOffers(
      analysisData?.lenderDeposits || [],
      res?.mcaPositions || [],
      +f.avgMonthly || 0
    );
    setCompetingOffers(result);
    setAnalyzingCompeting(false);
  };
  // FEATURE 10 handler
  const handleRecordMissedPayment = async () => {
    if (!missedPaymentModal) return;
    setRecordingMissed(true);
    const ok = await addMissedPayment(missedPaymentModal.dealId, missedPaymentNote);
    if (ok) {
      const [deals, stats] = await Promise.all([loadAllDeals(), loadStats()]);
      setAllDeals(deals);
      setDealStats(stats);
    }
    setMissedPaymentModal(null);
    setMissedPaymentNote("");
    setRecordingMissed(false);
  };
  const dm = res ? {
    APPROVE:      {label:"APPROVED",             c:C.green, bg:"rgba(24,160,88,0.08)",  bd:"rgba(24,160,88,0.25)"},
    APPROVE_STIPS:{label:"APPROVED WITH STIPS",  c:"#14a060",bg:"rgba(20,160,90,0.07)",bd:"rgba(20,160,90,0.22)"},
    CONDITIONAL:  {label:"CONDITIONAL APPROVAL", c:C.amber, bg:"rgba(208,128,32,0.08)", bd:"rgba(208,128,32,0.25)"},
    COUNTER:      {label:"COUNTER-OFFER",         c:C.amber, bg:"rgba(208,128,32,0.07)", bd:"rgba(208,128,32,0.22)"},
    DECLINE:      {label:"DECLINED",              c:C.red,   bg:"rgba(200,0,10,0.08)",  bd:"rgba(200,0,10,0.28)"},
  }[res.decision] : null;
  const isRestricted = f.state && RESTRICTED_STATES.includes(f.state);
  return (
    <div style={{minHeight:"100vh",background:C.bg,fontFamily:"'DM Sans',sans-serif",color:C.text}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        input:focus,select:focus{border-color:${C.accent}!important;box-shadow:0 0 0 3px rgba(200,0,10,0.12)!important;outline:none;}
        input::placeholder{color:#2a2a2a;}
        select option{background:#111;color:#d0cdc8;}
        .fade>*{animation:fu 0.3s both;}
        .fade>*:nth-child(1){animation-delay:0.03s}.fade>*:nth-child(2){animation-delay:0.07s}
        .fade>*:nth-child(3){animation-delay:0.11s}.fade>*:nth-child(4){animation-delay:0.15s}
        .fade>*:nth-child(5){animation-delay:0.19s}.fade>*:nth-child(6){animation-delay:0.23s}
        .fade>*:nth-child(7){animation-delay:0.27s}
        @keyframes fu{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
        .pulse{animation:pulse 1.8s ease-in-out infinite;}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}
        .dropzone:hover{border-color:${C.accent}!important;background:rgba(200,0,10,0.03)!important;}
        input[type=number]::-webkit-inner-spin-button{opacity:0.3;}
        /* FEATURE 8: offer letter print view */
        .offer-letter-print{display:none;}
        @media print{
          body > *{display:none !important;}
          .offer-letter-print{display:block !important; position:fixed; inset:0; background:white; color:black; padding:40px; z-index:9999; font-family:Georgia, serif;}
          .offer-letter-print *{color:black !important; background:white !important; border-color:#888 !important;}
          .offer-letter-print h1{font-size:24pt; border-bottom:2px solid black; padding-bottom:6pt; margin-bottom:16pt;}
          .offer-letter-print h2{font-size:13pt; margin-top:14pt; margin-bottom:6pt;}
          .offer-letter-print table{width:100%; border-collapse:collapse; margin:8pt 0;}
          .offer-letter-print td{padding:4pt 6pt; border-bottom:1px solid #ccc;}
          .offer-letter-print .no-print{display:none !important;}
        }
      `}</style>
      {/* Header */}
      <div style={{background:"#080808",borderBottom:`1px solid ${C.border}`,padding:"0 24px",height:56,display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{background:C.accent,width:30,height:30,borderRadius:7,display:"grid",placeItems:"center",fontFamily:"'IBM Plex Mono',monospace",fontWeight:700,color:"#fff",fontSize:14}}>EJ</div>
          <div>
            <div style={{fontWeight:700,fontSize:14,color:C.white}}>El Jay Capital</div>
            <div style={{fontSize:9,color:C.muted,letterSpacing:"0.1em"}}>AI-POWERED UNDERWRITING SYSTEM</div>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          {view!=="memory"&&(
            <div style={{display:"flex",gap:3}}>
              {["upload","form","result"].map((step,i)=>(
                <div key={step} style={{display:"flex",alignItems:"center",gap:3}}>
                  <div style={{width:22,height:22,borderRadius:"50%",background:view===step?C.accent:["upload","form","result"].indexOf(view)>i?"#2a2a2a":"#1a1a1a",border:`1px solid ${view===step?C.accent:"#2a2a2a"}`,display:"grid",placeItems:"center",fontSize:9,fontWeight:700,color:view===step?"#fff":C.muted,fontFamily:"'IBM Plex Mono',monospace"}}>
                    {i+1}
                  </div>
                  {i<2&&<div style={{width:18,height:1,background:"#1f1f1f"}}/>}
                </div>
              ))}
              <div style={{marginLeft:8,fontSize:10,color:C.muted,fontFamily:"'IBM Plex Mono',monospace"}}>
                {view==="upload"?"UPLOAD":view==="form"?"REVIEW":res?.decision||""}
              </div>
            </div>
          )}
          <button onClick={loadMemoryView} style={{display:"flex",alignItems:"center",gap:6,padding:"6px 12px",background:view==="memory"?"rgba(200,160,64,0.12)":"transparent",border:`1px solid ${view==="memory"?C.gold:"#2a2a2a"}`,borderRadius:7,cursor:"pointer",color:view==="memory"?C.gold:C.muted,fontSize:11,fontWeight:600,letterSpacing:"0.04em"}}>
            <span style={{fontSize:13}}>🧠</span> DEAL MEMORY
            {allDeals.length>0&&<span style={{background:view==="memory"?C.gold:"#2a2a2a",color:view==="memory"?"#000":C.muted,borderRadius:10,padding:"1px 5px",fontSize:9,fontWeight:700}}>{allDeals.length}</span>}
          </button>
        </div>
      </div>
      <div style={{maxWidth:900,margin:"0 auto",padding:"28px 16px"}}>
        {/* ── STEP 1: UPLOAD ── */}
        {view==="upload" && (
          <div className="fade">
            <div style={{marginBottom:22}}>
              <h1 style={{fontSize:22,fontWeight:700,color:C.white}}>Upload Bank Statements</h1>
              <p style={{color:C.muted,marginTop:4,fontSize:13}}>Upload 3–6 months of statements. Claude AI will analyze them and auto-fill the underwriting form.</p>
            </div>
            {/* Drop zone */}
            <div
              className="dropzone"
              onDrop={onDrop}
              onDragOver={e=>{e.preventDefault();setDragOver(true);}}
              onDragLeave={()=>setDragOver(false)}
              onClick={()=>fileInputRef.current?.click()}
              style={{border:`2px dashed ${dragOver?C.accent:"#2a2a2a"}`,borderRadius:14,padding:"44px 24px",textAlign:"center",cursor:"pointer",transition:"all 0.2s",background:dragOver?"rgba(200,0,10,0.04)":"transparent",marginBottom:16}}
            >
              <div style={{fontSize:32,marginBottom:12}}>📄</div>
              <div style={{fontSize:15,fontWeight:600,color:C.white,marginBottom:6}}>Drop bank statements here</div>
              <div style={{fontSize:12,color:C.muted,marginBottom:14}}>PDF or image files (JPG, PNG) · Up to 6 files · 3–6 months preferred</div>
              <div style={{display:"inline-block",background:C.accent,color:"#fff",padding:"8px 20px",borderRadius:7,fontSize:12,fontWeight:700,letterSpacing:"0.05em"}}>BROWSE FILES</div>
              <input ref={fileInputRef} type="file" multiple accept=".pdf,image/*" style={{display:"none"}} onChange={e=>handleFiles(e.target.files)}/>
            </div>
            {/* File list */}
            {uploadedFiles.length>0&&(
              <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"16px 18px",marginBottom:16}}>
                <div style={{fontSize:9.5,fontWeight:700,letterSpacing:"0.12em",color:C.muted,textTransform:"uppercase",marginBottom:12}}>Uploaded Files ({uploadedFiles.length})</div>
                {uploadedFiles.map((file,i)=>(
                  <div key={i} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px 0",borderBottom:i<uploadedFiles.length-1?`1px solid ${C.border2}`:"none"}}>
                    <div style={{display:"flex",alignItems:"center",gap:10}}>
                      <div style={{width:28,height:28,background:"#1a1a1a",borderRadius:6,display:"grid",placeItems:"center",fontSize:13}}>{file.type==="application/pdf"?"📄":"🖼️"}</div>
                      <div>
                        <div style={{fontSize:12.5,color:C.white,fontWeight:500}}>{file.name}</div>
                        <div style={{fontSize:10,color:C.muted}}>{(file.size/1024).toFixed(0)} KB</div>
                      </div>
                    </div>
                    <button onClick={()=>setUploadedFiles(prev=>prev.filter((_,j)=>j!==i))} style={{background:"transparent",border:"none",color:C.muted,cursor:"pointer",fontSize:16,padding:"2px 6px"}}>×</button>
                  </div>
                ))}
              </div>
            )}
            {analysisError&&(
              <div style={{background:"rgba(200,0,10,0.07)",border:`1px solid rgba(200,0,10,0.25)`,borderRadius:10,padding:"12px 16px",marginBottom:14,fontSize:12.5,color:"#e06060"}}>{analysisError}</div>
            )}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
              <button onClick={runAnalysis} disabled={!uploadedFiles.length||analyzing} style={{padding:"14px",background:uploadedFiles.length&&!analyzing?C.accent:"#1a1a1a",border:"none",borderRadius:10,color:uploadedFiles.length&&!analyzing?"#fff":C.muted,fontWeight:700,fontSize:14,cursor:uploadedFiles.length&&!analyzing?"pointer":"not-allowed",letterSpacing:"0.03em",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
                {analyzing?(
                  <><span className="pulse">●</span> Analyzing Statements...</>
                ):(
                  <>🤖 Analyze with AI →</>
                )}
              </button>
              <button onClick={()=>setView("form")} style={{padding:"14px",background:"transparent",border:`1px solid ${C.border}`,borderRadius:10,color:C.muted,fontSize:13,cursor:"pointer"}}>
                Skip — Enter Manually
              </button>
            </div>
            {/* What AI extracts */}
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"16px 18px",marginTop:16}}>
              <div style={{fontSize:9.5,fontWeight:700,color:C.muted,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:12}}>What the AI Extracts</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                {[
                  "Avg & lowest daily balance","Deposit frequency & sources",
                  "NSF count — 30 / 60 / 90 days","Negative balance days",
                  "Cash withdrawal %","MCA lenders & daily debit amounts",
                  "3 / 6 / 12 month revenue trend","Revenue volatility score",
                  "Payroll cycles & seasonality",
                  "Owner transfer patterns","Multi-lender shopping detection",
                ].map(item=>(
                  <div key={item} style={{display:"flex",gap:7,alignItems:"center"}}>
                    <div style={{width:4,height:4,borderRadius:"50%",background:C.gold,flexShrink:0}}/>
                    <span style={{fontSize:11.5,color:"#888"}}>{item}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
        {/* ── STEP 2: FORM ── */}
        {view==="form" && (
          <div className="fade">
            <div style={{marginBottom:18,display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
              <div>
                <h1 style={{fontSize:21,fontWeight:700,color:C.white}}>Review & Complete Deal</h1>
                <p style={{color:C.muted,marginTop:4,fontSize:12.5}}>{Object.keys(aiFilledFields).length>0?`AI pre-filled ${Object.keys(aiFilledFields).length} fields from your statements — review and complete remaining fields.`:"Enter deal details manually."}</p>
              </div>
              <button onClick={()=>setView("upload")} style={{background:"transparent",border:`1px solid ${C.border}`,borderRadius:7,color:C.muted,fontSize:11,padding:"6px 12px",cursor:"pointer"}}>← Re-upload</button>
            </div>
            {/* AI analysis summary */}
            {analysisData && (
              <div style={{background:"#0d0d0d",border:`1px solid #1f1f1f`,borderLeft:`3px solid ${C.gold}`,borderRadius:10,padding:"14px 16px",marginBottom:16}}>
                <div style={{fontSize:9.5,fontWeight:700,color:C.gold,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:12}}>🤖 AI Deep Analysis — {analysisData.monthsAnalyzed} Months · {analysisData.businessName||"Business"}</div>
                {/* AI Verdict */}
                {analysisData.aiVerdict&&(
                  <div style={{background:"#0a0a0a",border:`1px solid #202020`,borderRadius:8,padding:"10px 14px",marginBottom:12,fontSize:12,color:"#a09880",lineHeight:1.6,fontStyle:"italic"}}>💬 {analysisData.aiVerdict}</div>
                )}
                {/* Bank Intelligence row */}
                <div style={{fontSize:8.5,color:C.muted,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:8}}>Bank Account Intelligence</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8,marginBottom:12}}>
                  {[
                    {l:"Avg Daily Balance",v:`$${(analysisData.bankIntelligence?.avgDailyBalance||0).toLocaleString()}`,c:(analysisData.bankIntelligence?.avgDailyBalance||0)>=8000?C.green:(analysisData.bankIntelligence?.avgDailyBalance||0)>=3000?C.amber:C.red},
                    {l:"Lowest Daily Bal",v:`$${(analysisData.bankIntelligence?.lowestDailyBalance||0).toLocaleString()}`,c:(analysisData.bankIntelligence?.lowestDailyBalance||0)>=1000?C.green:(analysisData.bankIntelligence?.lowestDailyBalance||0)>=0?C.amber:C.red},
                    {l:"Deposit Freq",v:(analysisData.bankIntelligence?.depositFrequency||"?").toUpperCase(),c:analysisData.bankIntelligence?.depositFrequency==="daily"?C.green:analysisData.bankIntelligence?.depositFrequency==="weekly"?C.amber:C.red},
                    {l:"Deposit Sources",v:analysisData.bankIntelligence?.depositSources||"?",c:(analysisData.bankIntelligence?.depositSources||0)>=3?C.green:(analysisData.bankIntelligence?.depositSources||0)>=2?C.amber:C.red},
                    {l:"Cash Withdraw %",v:`${analysisData.bankIntelligence?.cashWithdrawPct||0}%`,c:(analysisData.bankIntelligence?.cashWithdrawPct||0)<10?C.green:(analysisData.bankIntelligence?.cashWithdrawPct||0)<20?C.amber:C.red},
                  ].map(it=>(
                    <div key={it.l} style={{background:"#0a0a0a",border:`1px solid #1a1a1a`,borderRadius:7,padding:"8px 10px",textAlign:"center"}}>
                      <div style={{fontSize:8,color:C.muted,textTransform:"uppercase",marginBottom:3}}>{it.l}</div>
                      <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:12,fontWeight:700,color:it.c}}>{it.v}</div>
                    </div>
                  ))}
                </div>
                {/* Revenue Quality row */}
                <div style={{fontSize:8.5,color:C.muted,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:8}}>Revenue Quality</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8,marginBottom:12}}>
                  {[
                    {l:"3mo Avg",v:`$${(analysisData.revenueQuality?.mo3avg||0).toLocaleString()}`},
                    {l:"6mo Avg",v:`$${(analysisData.revenueQuality?.mo6avg||0).toLocaleString()}`},
                    {l:"Trend",v:(analysisData.revenueQuality?.revTrend||"?").toUpperCase(),c:analysisData.revenueQuality?.revTrend==="up"?C.green:analysisData.revenueQuality?.revTrend==="down"?C.red:C.amber},
                    {l:"Volatility",v:(analysisData.revenueQuality?.revVolatility||"?").toUpperCase(),c:analysisData.revenueQuality?.revVolatility==="low"?C.green:analysisData.revenueQuality?.revVolatility==="medium"?C.amber:C.red},
                    {l:"Top Source",v:`${analysisData.bankIntelligence?.topSourcePct||0}%`,c:(analysisData.bankIntelligence?.topSourcePct||0)<60?C.green:(analysisData.bankIntelligence?.topSourcePct||0)<80?C.amber:C.red},
                  ].map(it=>(
                    <div key={it.l} style={{background:"#0a0a0a",border:`1px solid #1a1a1a`,borderRadius:7,padding:"8px 10px",textAlign:"center"}}>
                      <div style={{fontSize:8,color:C.muted,textTransform:"uppercase",marginBottom:3}}>{it.l}</div>
                      <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:12,fontWeight:700,color:it.c||C.gold}}>{it.v}</div>
                    </div>
                  ))}
                </div>
                {/* NSF 30/60/90 */}
                <div style={{fontSize:8.5,color:C.muted,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:8}}>NSF Analysis</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:12}}>
                  {[
                    {l:"NSF / 30 Days",v:analysisData.nsfAnalysis?.nsf30||0,c:(analysisData.nsfAnalysis?.nsf30||0)===0?C.green:(analysisData.nsfAnalysis?.nsf30||0)<=2?C.amber:C.red},
                    {l:"NSF / 60 Days",v:analysisData.nsfAnalysis?.nsf60||0,c:(analysisData.nsfAnalysis?.nsf60||0)===0?C.green:(analysisData.nsfAnalysis?.nsf60||0)<=3?C.amber:C.red},
                    {l:"NSF / 90 Days",v:analysisData.nsfAnalysis?.nsf90||0,c:(analysisData.nsfAnalysis?.nsf90||0)===0?C.green:(analysisData.nsfAnalysis?.nsf90||0)<=5?C.amber:C.red},
                    {l:"NSF Trend",v:(analysisData.nsfAnalysis?.nsfTrend||"stable").toUpperCase(),c:analysisData.nsfAnalysis?.nsfTrend==="improving"?C.green:analysisData.nsfAnalysis?.nsfTrend==="worsening"?C.red:C.amber},
                  ].map(it=>(
                    <div key={it.l} style={{background:"#0a0a0a",border:`1px solid #1a1a1a`,borderRadius:7,padding:"8px 10px",textAlign:"center"}}>
                      <div style={{fontSize:8,color:C.muted,textTransform:"uppercase",marginBottom:3}}>{it.l}</div>
                      <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:13,fontWeight:700,color:it.c}}>{it.v}</div>
                    </div>
                  ))}
                </div>
                {/* Patterns detected */}
                {analysisData.patterns&&Object.values(analysisData.patterns).some(Boolean)&&(
                  <div style={{marginBottom:12}}>
                    <div style={{fontSize:8.5,color:C.muted,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:8}}>Behavioral Patterns Detected</div>
                    <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                      {Object.entries(analysisData.patterns).filter(([,v])=>v).map(([k])=>{
                        const labels={payrollCycle:"💼 Payroll cycle",seasonality:"📅 Seasonality",weekendDips:"📉 Weekend dips",weekdayStrength:"📈 Weekday strength",rapidMcaPayoffHistory:"⚠️ Rapid MCA payoffs",multiLenderBankPulls:"⚠️ Multi-lender pulls",ownerTransfersIncreasing:"⚠️ Owner transfers rising",cashWithdrawalSpike:"⚠️ Cash spike",roundNumberDeposits:"⚠️ Round number deposits"};
                        const isRed=["multiLenderBankPulls"].includes(k);
                        const isAmber=["rapidMcaPayoffHistory","ownerTransfersIncreasing","cashWithdrawalSpike","roundNumberDeposits"].includes(k);
                        return <div key={k} style={{fontSize:10.5,padding:"3px 8px",borderRadius:5,background:isRed?"rgba(200,0,10,0.12)":isAmber?"rgba(208,128,32,0.12)":"rgba(24,160,88,0.1)",color:isRed?C.red:isAmber?C.amber:C.green,border:`1px solid ${isRed?"rgba(200,0,10,0.25)":isAmber?"rgba(208,128,32,0.25)":"rgba(24,160,88,0.2)"}`}}>{labels[k]||k}</div>;
                      })}
                    </div>
                  </div>
                )}
                {/* Monthly breakdown */}
                {analysisData.monthlyBreakdown?.length>0&&(
                  <div style={{marginBottom:analysisData.notes?10:0}}>
                    <div style={{fontSize:8.5,color:C.muted,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:8}}>Monthly Breakdown</div>
                    <div style={{display:"flex",gap:6,overflowX:"auto",paddingBottom:4}}>
                      {analysisData.monthlyBreakdown.map((mb,i)=>(
                        <div key={i} style={{flexShrink:0,background:"#141414",border:`1px solid #1f1f1f`,borderRadius:7,padding:"8px 10px",minWidth:88,textAlign:"center"}}>
                          <div style={{fontSize:9,color:C.muted,marginBottom:3}}>{mb.month}</div>
                          <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:11,fontWeight:700,color:C.white}}>${(mb.deposits||0).toLocaleString()}</div>
                          {mb.endingBalance!=null&&<div style={{fontSize:9,color:(mb.endingBalance||0)>=0?C.muted:C.red,marginTop:1}}>bal ${(mb.endingBalance||0).toLocaleString()}</div>}
                          {mb.nsfs>0&&<div style={{fontSize:9,color:C.red,marginTop:1}}>{mb.nsfs} NSF</div>}
                          {mb.negativeDays>0&&<div style={{fontSize:9,color:C.amber,marginTop:1}}>{mb.negativeDays}neg</div>}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {/* MCA Positions */}
                {analysisData.mcaPositions?.length>0&&(
                  <div style={{borderTop:`1px solid #1f1f1f`,paddingTop:12,marginTop:8}}>
                    <div style={{fontSize:9.5,fontWeight:700,color:C.red,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:10}}>
                      ⚡ {analysisData.mcaPositions.length} Active MCA Position{analysisData.mcaPositions.length>1?"s":""} — ${(analysisData.totalMonthlyMcaBurden||0).toLocaleString()}/mo burden
                    </div>
                    <div style={{display:"grid",gap:7}}>
                      {analysisData.mcaPositions.map((pos,i)=>(
                        <div key={i} style={{background:"#0a0808",border:`1px solid #2a1a1a`,borderLeft:`3px solid ${C.red}`,borderRadius:7,padding:"9px 13px",display:"grid",gridTemplateColumns:"1fr auto",gap:8}}>
                          <div>
                            <div style={{fontWeight:700,fontSize:12.5,color:C.white,marginBottom:4}}>{pos.lenderName}</div>
                            <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
                              <span style={{fontSize:10.5,color:C.muted}}>${(pos.debitAmount||0).toLocaleString()} / {pos.frequency}</span>
                              <span style={{fontSize:10.5,color:"#c05050",fontWeight:600}}>${(pos.totalMonthlyBurden||0).toLocaleString()}/mo</span>
                              {pos.estimatedRemainingBalance>0&&<span style={{fontSize:10.5,color:C.amber}}>~${pos.estimatedRemainingBalance.toLocaleString()} remaining</span>}
                            </div>
                          </div>
                          <div style={{fontSize:8,color:pos.confidence==="high"?C.green:C.amber,border:`1px solid currentColor`,borderRadius:4,padding:"2px 5px",height:"fit-content",fontWeight:700,letterSpacing:"0.08em",textTransform:"uppercase"}}>{pos.confidence}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {analysisData.mcaPositions?.length===0&&<div style={{borderTop:`1px solid #1f1f1f`,paddingTop:8,marginTop:8,fontSize:11,color:C.green}}>✓ No recurring MCA debits detected</div>}
                {/* ── LENDER DEPOSITS ── */}
                {analysisData.lenderDeposits?.length>0&&(
                  <div style={{borderTop:`1px solid #1f1f1f`,paddingTop:12,marginTop:10}}>
                    <div style={{fontSize:9.5,fontWeight:700,color:"#e07820",letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:10}}>
                      💰 Lender Deposits Detected — {analysisData.lenderDeposits.length} Funding Event{analysisData.lenderDeposits.length>1?"s":""}
                    </div>
                    <div style={{display:"grid",gap:6}}>
                      {analysisData.lenderDeposits.map((dep,i)=>{
                        const typeColors = {
                          MCA_FUNDING:{bg:"rgba(200,0,10,0.07)",bd:"rgba(200,0,10,0.2)",c:C.red,tag:"MCA FUNDING"},
                          LOAN_PROCEEDS:{bg:"rgba(72,120,192,0.07)",bd:"rgba(72,120,192,0.2)",c:C.blue,tag:"LOAN"},
                          LINE_OF_CREDIT:{bg:"rgba(72,120,192,0.07)",bd:"rgba(72,120,192,0.2)",c:C.blue,tag:"LINE OF CREDIT"},
                          OTHER_LENDER:{bg:"rgba(208,128,32,0.07)",bd:"rgba(208,128,32,0.2)",c:C.amber,tag:"LENDER"},
                        };
                        const tc = typeColors[dep.type]||typeColors.OTHER_LENDER;
                        return (
                          <div key={i} style={{background:tc.bg,border:`1px solid ${tc.bd}`,borderRadius:7,padding:"9px 13px",display:"grid",gridTemplateColumns:"1fr auto",gap:10,alignItems:"center"}}>
                            <div>
                              <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:4}}>
                                <span style={{fontWeight:700,fontSize:12.5,color:C.white}}>{dep.lenderName}</span>
                                <span style={{fontSize:8,fontWeight:700,color:tc.c,border:`1px solid ${tc.bd}`,borderRadius:4,padding:"1px 5px",letterSpacing:"0.06em"}}>{tc.tag}</span>
                              </div>
                              <div style={{fontSize:10.5,color:C.muted,fontFamily:"'IBM Plex Mono',monospace"}}>{dep.description}</div>
                            </div>
                            <div style={{textAlign:"right",flexShrink:0}}>
                              <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:14,fontWeight:700,color:C.green}}>+${(dep.amount||0).toLocaleString()}</div>
                              <div style={{fontSize:9.5,color:C.muted,marginTop:1}}>{dep.depositDate}</div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <div style={{marginTop:8,fontSize:10.5,color:"#605040",fontStyle:"italic"}}>
                      ⚠ These are inbound funding events detected in the statement — not MCA debits. Review for undisclosed liabilities or refinancing history.
                    </div>
                  </div>
                )}
                {analysisData.lenderDeposits?.length===0&&(
                  <div style={{borderTop:`1px solid #1f1f1f`,paddingTop:8,marginTop:8,fontSize:11,color:C.green}}>✓ No lender deposits detected</div>
                )}
                {analysisData.notes&&<div style={{fontSize:11,color:"#686050",fontStyle:"italic",borderTop:`1px solid #1f1f1f`,paddingTop:8,marginTop:8}}>📝 {analysisData.notes}</div>}
              </div>
            )}
            {/* Eligibility bar */}
            <div style={{background:"#0d0d0d",border:`1px solid ${C.border2}`,borderRadius:9,padding:"10px 16px",marginBottom:14,display:"flex",gap:20,flexWrap:"wrap"}}>
              {[{l:"Range",v:"$5K–$70K"},{l:"Max Term",v:"120 Days"},{l:"Factor Rate",v:"1.50x",c:C.gold},{l:"Restricted",v:"CA·VA·NY·TX",warn:true}].map(it=>(
                <div key={it.l}><div style={{fontSize:8.5,color:C.muted,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:1}}>{it.l}</div><div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:11.5,fontWeight:700,color:it.warn?C.red:C.gold}}>{it.v}</div></div>
              ))}
            </div>
            {/* Bank data section */}
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"18px 20px",marginBottom:13,borderTop:`2px solid ${C.accent}`}}>
              <div style={{fontSize:9.5,fontWeight:700,letterSpacing:"0.14em",color:C.accent,marginBottom:14,textTransform:"uppercase"}}>★ Revenue & Bank Data</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:13}}>
                <Fld label="Avg Monthly Revenue ($)" highlight={aiFilledFields.avgMonthly} hint="3–6 month avg"><input style={{...inp,borderColor:aiFilledFields.avgMonthly?"rgba(200,160,64,0.4)":C.border}} type="number" value={f.avgMonthly} onChange={e=>s("avgMonthly",e.target.value)} placeholder="e.g. 45000"/></Fld>
                <Fld label="Lowest Month ($)" highlight={aiFilledFields.lowestMonth}><input style={{...inp,borderColor:aiFilledFields.lowestMonth?"rgba(200,160,64,0.4)":C.border}} type="number" value={f.lowestMonth} onChange={e=>s("lowestMonth",e.target.value)} placeholder="e.g. 32000"/></Fld>
                <Fld label="Avg Deposits / Month" highlight={aiFilledFields.depositCount}><input style={{...inp,borderColor:aiFilledFields.depositCount?"rgba(200,160,64,0.4)":C.border}} type="number" value={f.depositCount} onChange={e=>s("depositCount",e.target.value)} placeholder="e.g. 10"/></Fld>
                <Fld label="NSFs / Month" highlight={aiFilledFields.nsfs}><input style={{...inp,borderColor:aiFilledFields.nsfs?"rgba(200,160,64,0.4)":C.border}} type="number" value={f.nsfs} onChange={e=>s("nsfs",e.target.value)} placeholder="0"/></Fld>
                <Fld label="Negative Balance Days / Month" highlight={aiFilledFields.negativeDays}><input style={{...inp,borderColor:aiFilledFields.negativeDays?"rgba(200,160,64,0.4)":C.border}} type="number" value={f.negativeDays} onChange={e=>s("negativeDays",e.target.value)} placeholder="0"/></Fld>
                <Fld label="Existing MCA Balance ($)" highlight={aiFilledFields.existingBalance}><input style={{...inp,borderColor:aiFilledFields.existingBalance?"rgba(200,160,64,0.4)":C.border}} type="number" value={f.existingBalance} onChange={e=>s("existingBalance",e.target.value)} placeholder="0"/></Fld>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:13,marginBottom:18}}>
              {/* Business */}
              <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"16px 18px"}}>
                <div style={{fontSize:9.5,fontWeight:700,letterSpacing:"0.14em",color:C.muted,marginBottom:13,textTransform:"uppercase"}}>Business Info</div>
                <div style={{display:"grid",gap:11}}>
                  <Fld label="Business Name" highlight={aiFilledFields.businessName}><input style={{...inp,borderColor:aiFilledFields.businessName?"rgba(200,160,64,0.4)":C.border}} value={f.businessName} onChange={e=>s("businessName",e.target.value)} placeholder="e.g. Metro Diner LLC"/></Fld>
                  <Fld label="State">
                    <select style={{...sel,borderColor:isRestricted?C.red:C.border}} value={f.state} onChange={e=>s("state",e.target.value)}>
                      <option value="">— Select State —</option>
                      {US_STATES.map(st=><option key={st} value={st}>{st}{RESTRICTED_STATES.includes(st)?" ✗":""}</option>)}
                    </select>
                    {isRestricted&&<p style={{fontSize:10,color:C.red,marginTop:2}}>El Jay does not fund this state</p>}
                  </Fld>
                  <Fld label="Industry">
                    <select style={sel} value={f.industry} onChange={e=>s("industry",e.target.value)}>
                      {INDUSTRIES.map(i=><option key={i.label}>{i.label}</option>)}
                    </select>
                  </Fld>
                  <Fld label="Time in Business (months)"><input style={inp} type="number" value={f.timeInBusiness} onChange={e=>s("timeInBusiness",e.target.value)} placeholder="e.g. 30"/></Fld>
                  <Fld label="Owner FICO Score"><input style={inp} type="number" value={f.creditScore} onChange={e=>s("creditScore",e.target.value)} placeholder="e.g. 600"/></Fld>
                  {/* FEATURE 3: Merchant health check */}
                  <button
                    onClick={handleCheckHealth}
                    disabled={checkingHealth || !f.businessName || !f.state}
                    style={{padding:"10px",background:checkingHealth?"#1a1a1a":"transparent",border:`1px solid ${C.gold}`,borderRadius:8,color:checkingHealth?C.muted:C.gold,fontSize:11,fontWeight:700,letterSpacing:"0.06em",cursor:(!f.businessName||!f.state||checkingHealth)?"not-allowed":"pointer",opacity:(!f.businessName||!f.state)?0.4:1}}>
                    {checkingHealth ? "● Checking…" : "🔍 Check Business Health"}
                  </button>
                  {merchantHealth && (
                    <div style={{background:"#0a0a0a",border:`1px solid ${merchantHealth.healthScore==="green"?C.green:merchantHealth.healthScore==="yellow"?C.amber:C.red}`,borderRadius:8,padding:"10px 12px",fontSize:11,color:C.white}}>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                        <span style={{fontWeight:700,letterSpacing:"0.06em",color:merchantHealth.healthScore==="green"?C.green:merchantHealth.healthScore==="yellow"?C.amber:C.red}}>
                          {merchantHealth.healthScore==="green"?"● HEALTHY":merchantHealth.healthScore==="yellow"?"● CAUTION":"● RED FLAG"}
                        </span>
                        <span style={{color:C.muted,fontSize:10}}>SOS: {merchantHealth.sosStatus||"?"}</span>
                      </div>
                      <div style={{marginBottom:4,color:C.muted}}>{merchantHealth.summary}</div>
                      {(merchantHealth.googleRating != null) && <div style={{color:C.muted,fontSize:10}}>★ {merchantHealth.googleRating} ({merchantHealth.googleReviewCount||0} reviews · {merchantHealth.reviewSentiment})</div>}
                      {merchantHealth.hasWebsite && merchantHealth.websiteUrl && <div style={{color:C.muted,fontSize:10}}>🌐 {merchantHealth.websiteUrl}</div>}
                      {(merchantHealth.riskFlags||[]).length>0 && (
                        <div style={{marginTop:6,paddingTop:6,borderTop:`1px solid ${C.border}`}}>
                          {merchantHealth.riskFlags.map((r,i)=>(<div key={i} style={{color:C.red,fontSize:10}}>⚠ {r}</div>))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>
              {/* Deal */}
              <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"16px 18px"}}>
                <div style={{fontSize:9.5,fontWeight:700,letterSpacing:"0.14em",color:C.muted,marginBottom:13,textTransform:"uppercase"}}>Deal Structure</div>
                <div style={{display:"grid",gap:11}}>
                  <Fld label="Requested Advance ($)"><input style={inp} type="number" value={f.requestedAmount} onChange={e=>s("requestedAmount",e.target.value)} placeholder="e.g. 50000"/></Fld>
                  <Fld label="Position">
                    <select style={{...sel,borderColor:f.position==="1st"?C.red:C.border}} value={f.position} onChange={e=>s("position",e.target.value)}>
                      <option value="1st">1st Position ✗</option>
                      <option value="2nd">2nd Position</option>
                      <option value="3rd">3rd Position</option>
                      <option value="4th">4th Position</option>
                      <option value="5th">5th Position</option>
                      <option value="6th">6th Position</option>
                      <option value="7th">7th Position</option>
                    </select>
                    {f.position==="1st"&&<p style={{fontSize:10,color:C.red,marginTop:2}}>El Jay does not fund 1st position</p>}                  </Fld>
                  <div style={{display:"grid",gap:9,marginTop:2}}>
                    <Toggle label="Merchant has prior MCA history" value={f.mcaHistory} onChange={v=>s("mcaHistory",v)}/>
                    <Toggle label="Prior MCA default on record" value={f.priorDefault} onChange={v=>s("priorDefault",v)} warn/>
                  </div>
                  <div style={{background:"#0a0a0a",border:`1px solid ${C.border}`,borderRadius:8,padding:"11px 13px",marginTop:2}}>
                    <div style={{fontSize:8.5,color:C.muted,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:4}}>Est. Max Advance</div>
                    <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:18,fontWeight:700,color:C.gold}}>
                      {f.avgMonthly?`$${Math.min(Math.round(+f.avgMonthly*1.25),70000).toLocaleString()}`:"—"}
                    </div>
                    <div style={{fontSize:9.5,color:C.muted,marginTop:1}}>~1.25× monthly revenue · max $70K</div>
                  </div>
                </div>
              </div>
            </div>
            {/* ── MCA POSITIONS EDITOR ── */}
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"18px 20px",marginBottom:13,borderTop:`2px solid #8b1a1a`}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                <div>
                  <div style={{fontSize:9.5,fontWeight:700,letterSpacing:"0.14em",color:"#c05050",textTransform:"uppercase"}}>⚡ Active MCA Positions</div>
                  <div style={{fontSize:10,color:C.muted,marginTop:2}}>
                    {(f.mcaPositions||[]).length === 0 ? "No positions — add manually or AI will detect from statements" : `${(f.mcaPositions||[]).length} position${(f.mcaPositions||[]).length!==1?"s":""} · $${((f.mcaPositions||[]).reduce((s,p)=>s+(p.totalMonthlyBurden||0),0)).toLocaleString()}/mo total burden`}
                  </div>
                </div>
                <button
                  onClick={()=>{
                    const blank = {lenderName:"",debitAmount:0,frequency:"daily",debitsPerMonth:22,totalMonthlyBurden:0,estimatedRemainingBalance:0,confidence:"high"};
                    s("mcaPositions",[...(f.mcaPositions||[]),blank]);
                  }}
                  style={{display:"flex",alignItems:"center",gap:5,padding:"7px 13px",background:"rgba(200,0,10,0.1)",border:`1px solid rgba(200,0,10,0.3)`,borderRadius:7,color:"#e06060",fontSize:11,fontWeight:700,cursor:"pointer",letterSpacing:"0.04em"}}>
                  + Add Position
                </button>
              </div>
              {(f.mcaPositions||[]).length === 0 && (
                <div style={{textAlign:"center",padding:"20px 0",color:"#2a2a2a",fontSize:12}}>
                  No MCA positions added. Click <strong style={{color:"#503030"}}>+ Add Position</strong> to enter manually, or upload bank statements for AI detection.
                </div>
              )}
              <div style={{display:"grid",gap:10}}>
                {(f.mcaPositions||[]).map((pos,i)=>{
                  const updatePos = (key, val) => {
                    const updated = (f.mcaPositions||[]).map((p,j) => {
                      if (j !== i) return p;
                      const next = {...p, [key]: val};
                      // Auto-calc monthly burden when amount or frequency changes
                      if (key === "debitAmount" || key === "debitsPerMonth" || key === "frequency") {
                        const amt = key==="debitAmount" ? +val : +next.debitAmount||0;
                        const freq = key==="frequency" ? val : next.frequency;
                        const perMo = key==="debitsPerMonth" ? +val : (freq==="daily" ? 22 : freq==="weekly" ? 4 : +next.debitsPerMonth||0);
                        next.totalMonthlyBurden = Math.round(amt * perMo);
                        if (key !== "debitsPerMonth") next.debitsPerMonth = perMo;
                      }
                      return next;
                    });
                    s("mcaPositions", updated);
                    // Recalc totalMonthlyMcaBurden
                    const total = updated.reduce((sum,p)=>sum+(p.totalMonthlyBurden||0),0);
                    s("totalMonthlyMcaBurden", total);
                  };
                  const deletePos = () => {
                    const updated = (f.mcaPositions||[]).filter((_,j)=>j!==i);
                    s("mcaPositions", updated);
                    s("totalMonthlyMcaBurden", updated.reduce((sum,p)=>sum+(p.totalMonthlyBurden||0),0));
                  };
                  const rejectAndDelete = async () => {
                    if (pos.lenderName && pos.lenderName.trim().length >= 2) {
                      await rejectLender(pos.lenderName);
                    }
                    deletePos();
                  };
                  const normName = (pos.lenderName||"").trim().toUpperCase().replace(/\s+/g," ");
                  const isKnown = !!knownLenders[normName];
                  const isRejected = !!rejectedLenders[normName];
                  const burdenColor = (pos.totalMonthlyBurden||0) > (+f.avgMonthly||1)*0.20 ? C.red : C.amber;
                  return (
                    <div key={i} style={{background:"#0a0808",border:`1px solid ${isRejected?"rgba(200,0,10,0.45)":"#2a1818"}`,borderLeft:`3px solid ${C.red}`,borderRadius:9,padding:"13px 15px"}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:11,flexWrap:"wrap",gap:6}}>
                        <div style={{display:"flex",gap:8,alignItems:"center"}}>
                          <div style={{fontSize:10,fontWeight:700,color:"#c05050",letterSpacing:"0.08em",textTransform:"uppercase"}}>Position {i+1}</div>
                          {isKnown && <span title="El Jay has confirmed this is a real lender" style={{fontSize:8.5,color:C.green,border:`1px solid rgba(24,160,88,0.4)`,borderRadius:4,padding:"1px 5px",fontWeight:700,letterSpacing:"0.06em"}}>✓ KNOWN</span>}
                          {isRejected && <span title="Previously flagged as NOT a lender" style={{fontSize:8.5,color:C.red,border:`1px solid rgba(200,0,10,0.4)`,borderRadius:4,padding:"1px 5px",fontWeight:700,letterSpacing:"0.06em"}}>✗ REJECTED</span>}
                        </div>
                        <div style={{display:"flex",gap:6}}>
                          <button onClick={rejectAndDelete} title="Remove and teach AI this is NOT a lender" style={{background:"rgba(200,0,10,0.08)",border:`1px solid rgba(200,0,10,0.3)`,borderRadius:5,color:C.red,fontSize:10.5,padding:"3px 8px",cursor:"pointer",fontWeight:600}}>✗ Not a Lender</button>
                          <button onClick={deletePos} title="Remove without training" style={{background:"transparent",border:`1px solid #2a2a2a`,borderRadius:5,color:C.muted,fontSize:10.5,padding:"3px 8px",cursor:"pointer",fontWeight:600}}>Remove</button>
                        </div>
                      </div>
                      <div style={{display:"grid",gridTemplateColumns:"2fr 1fr 1fr 1fr",gap:9,marginBottom:9}}>
                        <div>
                          <label style={{fontSize:8.5,color:C.muted,letterSpacing:"0.1em",textTransform:"uppercase",display:"block",marginBottom:3}}>Lender Name</label>
                          <input style={{...inp,borderColor:"#2a1818"}} value={pos.lenderName||""} onChange={e=>updatePos("lenderName",e.target.value)} placeholder="e.g. Rapid Finance"/>
                        </div>
                        <div>
                          <label style={{fontSize:8.5,color:C.muted,letterSpacing:"0.1em",textTransform:"uppercase",display:"block",marginBottom:3}}>Debit Amount ($)</label>
                          <input style={{...inp,borderColor:"#2a1818"}} type="number" value={pos.debitAmount||""} onChange={e=>updatePos("debitAmount",e.target.value)} placeholder="e.g. 450"/>
                        </div>
                        <div>
                          <label style={{fontSize:8.5,color:C.muted,letterSpacing:"0.1em",textTransform:"uppercase",display:"block",marginBottom:3}}>Frequency</label>
                          <select style={{...sel,borderColor:"#2a1818"}} value={pos.frequency||"daily"} onChange={e=>updatePos("frequency",e.target.value)}>
                            <option value="daily">Daily (Mon–Fri, 22×/mo)</option>
                            <option value="weekly">Weekly (4×/mo)</option>
                            <option value="biweekly">Biweekly (2×/mo)</option>
                          </select>
                        </div>
                        <div>
                          <label style={{fontSize:8.5,color:C.muted,letterSpacing:"0.1em",textTransform:"uppercase",display:"block",marginBottom:3}}>Times/Month</label>
                          <input style={{...inp,borderColor:"#2a1818"}} type="number" value={pos.debitsPerMonth||""} onChange={e=>updatePos("debitsPerMonth",e.target.value)} placeholder="22"/>
                        </div>
                      </div>
                      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:9}}>
                        <div>
                          <label style={{fontSize:8.5,color:C.muted,letterSpacing:"0.1em",textTransform:"uppercase",display:"block",marginBottom:3}}>Est. Remaining Balance ($)</label>
                          <input style={{...inp,borderColor:"#2a1818"}} type="number" value={pos.estimatedRemainingBalance||""} onChange={e=>updatePos("estimatedRemainingBalance",+e.target.value)} placeholder="0"/>
                        </div>
                        <div>
                          <label style={{fontSize:8.5,color:C.muted,letterSpacing:"0.1em",textTransform:"uppercase",display:"block",marginBottom:3}}>Confidence</label>
                          <select style={{...sel,borderColor:"#2a1818"}} value={pos.confidence||"high"} onChange={e=>updatePos("confidence",e.target.value)}>
                            <option value="high">High — AI confirmed</option>
                            <option value="medium">Medium — probable</option>
                            <option value="low">Low — estimated</option>
                          </select>
                        </div>
                        <div style={{display:"flex",flexDirection:"column",justifyContent:"flex-end"}}>
                          <div style={{background:"#0f0808",border:`1px solid #2a1414`,borderRadius:7,padding:"8px 11px",textAlign:"center"}}>
                            <div style={{fontSize:8,color:C.muted,textTransform:"uppercase",marginBottom:2}}>Monthly Burden</div>
                            <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:15,fontWeight:700,color:burdenColor}}>${(pos.totalMonthlyBurden||0).toLocaleString()}</div>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
              {/* Stack summary */}
              {(f.mcaPositions||[]).length > 0 && (
                <div style={{marginTop:12,background:"#0f0808",border:`1px solid #2a1414`,borderRadius:8,padding:"10px 14px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <div style={{fontSize:11,color:C.muted}}>
                    Total stack burden &nbsp;·&nbsp; {(f.mcaPositions||[]).length} lender{(f.mcaPositions||[]).length!==1?"s":""}
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:16,fontWeight:700,
                      color:f.avgMonthly&&((f.mcaPositions||[]).reduce((s,p)=>s+(p.totalMonthlyBurden||0),0)/(+f.avgMonthly))>0.30?C.red:C.amber}}>
                      ${((f.mcaPositions||[]).reduce((s,p)=>s+(p.totalMonthlyBurden||0),0)).toLocaleString()}<span style={{fontSize:10,color:C.muted}}>/mo</span>
                    </div>
                    {f.avgMonthly&&<div style={{fontSize:9,color:C.muted}}>
                      {Math.round(((f.mcaPositions||[]).reduce((s,p)=>s+(p.totalMonthlyBurden||0),0)/(+f.avgMonthly))*100)}% of monthly revenue
                    </div>}
                  </div>
                </div>
              )}
            </div>
            <button onClick={submit} style={{width:"100%",padding:"14px",background:C.accent,border:"none",borderRadius:10,color:"#fff",fontWeight:700,fontSize:14,cursor:"pointer",letterSpacing:"0.04em",textTransform:"uppercase"}}>
              Run El Jay Underwriting Decision →
            </button>
          </div>
        )}
        {/* ── STEP 3: RESULT ── */}
        {view==="result" && res && dm && (
          <div className="fade">
            {/* Decision banner */}
            <div style={{background:dm.bg,border:`2px solid ${dm.bd}`,borderRadius:13,padding:"20px 24px",marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{flex:1}}>
                <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,color:C.muted,letterSpacing:"0.14em",marginBottom:4}}>EL JAY CAPITAL · {(f.businessName||"MERCHANT").toUpperCase()}</div>
                <div style={{fontSize:28,fontWeight:800,color:dm.c,lineHeight:1.1}}>{dm.label}</div>
                <div style={{fontSize:11.5,color:dm.c,opacity:0.7,marginTop:5,lineHeight:1.5}}>
                  {res.decision==="APPROVE"&&"✓ Clear to fund — all criteria met. Submit to Submissions@EljayCapital.com"}
                  {res.decision==="APPROVE_STIPS"&&"✓ Approved — collect all stipulations, then submit to El Jay Capital"}
                  {res.decision==="CONDITIONAL"&&"⚑ Conditional — all stipulations must be satisfied before funding"}
                  {res.decision==="COUNTER"&&"↩ Counter-offer available — merchant must address flagged conditions"}
                  {res.decision==="DECLINE"&&"✗ Does not meet El Jay Capital eligibility requirements"}
                </div>
                {/* AI verdict inline */}
                {analysisData?.aiVerdict&&(
                  <div style={{marginTop:10,fontSize:11.5,color:"#909080",fontStyle:"italic",lineHeight:1.55,maxWidth:580}}>"{analysisData.aiVerdict}"</div>
                )}
              </div>
              <div style={{textAlign:"right",flexShrink:0,marginLeft:20}}>
                <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:9,color:C.muted,letterSpacing:"0.1em",marginBottom:2}}>RISK SCORE</div>
                <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:52,fontWeight:700,color:dm.c,lineHeight:1}}>{res.totalScore}</div>
                <div style={{fontSize:9.5,color:C.muted}}>/ 90</div>
                {res.fraudSignals?.filter(s=>s.level==="high").length>0&&(
                  <div style={{marginTop:6,fontSize:9,color:C.red,fontWeight:700,letterSpacing:"0.06em",background:"rgba(200,0,10,0.1)",border:`1px solid rgba(200,0,10,0.3)`,borderRadius:5,padding:"3px 7px"}}>
                    🚨 {res.fraudSignals.filter(s=>s.level==="high").length} FRAUD SIGNAL{res.fraudSignals.filter(s=>s.level==="high").length>1?"S":""}
                  </div>
                )}
              </div>
            </div>
            {/* Hard declines */}
            {res.hardDeclines?.length>0&&(
              <div style={{background:"rgba(200,0,10,0.07)",border:`1px solid rgba(200,0,10,0.28)`,borderRadius:10,padding:"14px 18px",marginBottom:11}}>
                <div style={{fontSize:9.5,fontWeight:700,color:C.red,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:9}}>✗ Hard Decline Reasons</div>
                {res.hardDeclines.map((r,i)=><div key={i} style={{fontSize:12,color:"#d06060",marginBottom:5,paddingLeft:11,borderLeft:`2px solid ${C.red}`}}>{r}</div>)}
              </div>
            )}
            {/* FEATURE 8: Offer letter actions (approved deals only) */}
            {res.decision!=="DECLINE"&&(
              <div style={{display:"flex",gap:10,marginBottom:11}}>
                <button onClick={()=>setShowOfferLetter(true)} style={{flex:1,padding:"11px",background:C.gold,border:"none",borderRadius:8,color:"#000",fontWeight:700,fontSize:12,cursor:"pointer",letterSpacing:"0.04em"}}>📄 Generate Offer Letter</button>
                <button onClick={()=>window.print()} style={{flex:1,padding:"11px",background:"transparent",border:`1px solid ${C.gold}`,borderRadius:8,color:C.gold,fontWeight:700,fontSize:12,cursor:"pointer",letterSpacing:"0.04em"}}>🖨 Print Offer Letter</button>
              </div>
            )}
            {/* ── RISK PROFILE + CASH FLOW SAFETY + APPROVED STRUCTURE ── */}
            {res.decision!=="DECLINE"&&res.riskProfile&&(
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:11}}>
                {/* RISK PROFILE */}
                <div style={{background:"#0c0c10",border:`1px solid #1e1e2e`,borderLeft:`3px solid ${res.riskBand==="LOW RISK"?C.green:res.riskBand==="MODERATE RISK"?C.amber:C.red}`,borderRadius:10,padding:"14px 16px"}}>
                  <div style={{fontSize:8.5,fontWeight:700,color:C.muted,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:10}}>Risk Profile</div>
                  <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                    <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:34,fontWeight:700,color:res.riskBand==="LOW RISK"?C.green:res.riskBand==="MODERATE RISK"?C.amber:C.red,lineHeight:1}}>{res.totalScore}</div>
                    <div>
                      <div style={{fontSize:8,color:C.muted,textTransform:"uppercase",letterSpacing:"0.08em"}}>Score</div>
                      <div style={{fontSize:11,fontWeight:700,color:res.riskBand==="LOW RISK"?C.green:res.riskBand==="MODERATE RISK"?C.amber:C.red}}>{res.riskBand}</div>
                    </div>
                  </div>
                  <div style={{fontSize:8.5,color:C.muted,letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:6}}>Key Risk Drivers</div>
                  {res.riskProfile.keyRiskDrivers.map((d,i)=>(
                    <div key={i} style={{display:"flex",gap:6,marginBottom:4,alignItems:"flex-start"}}>
                      <span style={{color:C.red,fontSize:9,marginTop:1,flexShrink:0}}>▸</span>
                      <span style={{fontSize:11,color:"#908070",lineHeight:1.4}}>{d}</span>
                    </div>
                  ))}
                  {/* FEATURE 1: show industry penalty */}
                  {res.industryPenalty>0 && (
                    <div style={{marginTop:7,paddingTop:7,borderTop:`1px solid ${C.border}`,fontSize:10.5,color:C.amber}}>
                      Industry penalty: −{res.industryPenalty} pts ({f.industry})
                    </div>
                  )}
                </div>
                {/* CASH FLOW SAFETY */}
                <div style={{background:"#0c100c",border:`1px solid #1a281a`,borderLeft:`3px solid ${res.cashFlowSafety?.stressTestPass?C.green:C.amber}`,borderRadius:10,padding:"14px 16px"}}>
                  <div style={{fontSize:8.5,fontWeight:700,color:C.muted,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:10}}>Cash Flow Safety</div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:10}}>
                    {[
                      {l:"Safe Daily Payment",v:`$${(res.cashFlowSafety?.safeDailyPayment||0).toLocaleString()}`,c:C.green},
                      {l:"Actual Daily ACH",v:`$${res.dailyPayment.toLocaleString()}`,c:res.dailyPayment<=(res.cashFlowSafety?.safeDailyPayment||0)?C.green:C.amber},
                      {l:"10-Day Miss Exposure",v:`$${(res.cashFlowSafety?.tenDayExposure||0).toLocaleString()}`,c:C.white},
                      {l:"Revenue Used",v:`$${(res.cashFlowSafety?.effectiveRevUsed||0).toLocaleString()}`,c:C.muted},
                    ].map(it=>(
                      <div key={it.l} style={{background:"#0a0a0a",borderRadius:6,padding:"7px 9px"}}>
                        <div style={{fontSize:8,color:C.muted,textTransform:"uppercase",marginBottom:2}}>{it.l}</div>
                        <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:12,fontWeight:700,color:it.c}}>{it.v}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{padding:"8px 10px",borderRadius:6,background:res.cashFlowSafety?.stressTestPass?"rgba(24,160,88,0.08)":"rgba(208,128,32,0.08)",border:`1px solid ${res.cashFlowSafety?.stressTestPass?"rgba(24,160,88,0.2)":"rgba(208,128,32,0.2)"}`}}>
                    <div style={{fontSize:8.5,fontWeight:700,color:res.cashFlowSafety?.stressTestPass?C.green:C.amber,letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:3}}>10-Day Miss Test: {res.cashFlowSafety?.stressTestPass?"PASS":"MARGINAL"}</div>
                    <div style={{fontSize:10.5,color:"#706050",lineHeight:1.4}}>{res.cashFlowSafety?.stressTestResult}</div>
                  </div>
                </div>
              </div>
            )}
            {/* ── APPROVED STRUCTURE ── */}
            {res.decision!=="DECLINE"&&(
              <div style={{background:"#0a0d0a",border:`1px solid #1c261c`,borderLeft:`3px solid ${C.gold}`,borderRadius:12,padding:"16px 18px",marginBottom:11}}>
                <div style={{fontSize:9.5,fontWeight:700,color:C.gold,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:14}}>Approved Structure</div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:8,marginBottom:12}}>
                  {[
                    {l:"Max Amount",v:`$${res.approvedAdvance.toLocaleString()}`,c:C.green},
                    {l:"Factor Rate",v:`${res.factorRate}×`,c:C.gold},
                    {l:"Total Payback",v:`$${res.payback.toLocaleString()}`,c:C.white},
                    {l:"Term",v:`${res.termDays}d`,c:C.muted},
                    {l:"Daily ACH",v:`$${res.dailyPayment.toLocaleString()}`,c:C.blue},
                    {l:"Pricing Tier",v:res.pricingTier?.split("—")[0]?.trim()||"",c:C.muted},
                  ].map(it=>(
                    <div key={it.l} style={{background:"#0a0a0a",border:`1px solid #1a1a1a`,borderRadius:7,padding:"9px 10px",textAlign:"center"}}>
                      <div style={{fontSize:7.5,color:C.muted,textTransform:"uppercase",letterSpacing:"0.08em",marginBottom:3}}>{it.l}</div>
                      <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:12,fontWeight:700,color:it.c}}>{it.v}</div>
                    </div>
                  ))}
                </div>
                {res.protectiveConditions?.length>0&&(
                  <div>
                    <div style={{fontSize:8.5,color:"#e07020",letterSpacing:"0.1em",textTransform:"uppercase",fontWeight:700,marginBottom:8}}>⚙ Protective Conditions</div>
                    {res.protectiveConditions.map((c,i)=>(
                      <div key={i} style={{display:"flex",gap:7,marginBottom:6,alignItems:"flex-start"}}>
                        <span style={{color:"#e07020",fontSize:9,marginTop:2,flexShrink:0}}>◆</span>
                        <span style={{fontSize:11.5,color:"#907040",lineHeight:1.5}}>{c}</span>
                      </div>
                    ))}
                  </div>
                )}
                {res.rationale&&(
                  <div style={{marginTop:12,paddingTop:10,borderTop:`1px solid #1c261c`,fontSize:12,color:"#808060",fontStyle:"italic",lineHeight:1.55}}>
                    Rationale: {res.rationale}
                  </div>
                )}
              </div>
            )}
            {/* FRAUD & BEHAVIORAL SIGNALS */}
            {res.fraudSignals?.length>0&&(
              <div style={{background:"#0e0a08",border:`1px solid #3a2010`,borderRadius:12,padding:"14px 18px",marginBottom:11}}>
                <div style={{fontSize:9.5,fontWeight:700,color:"#e06820",letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:12}}>
                  🔍 Behavioral & Fraud Signal Analysis ({res.fraudSignals.length})
                </div>
                <div style={{display:"grid",gap:7}}>
                  {res.fraudSignals.map((sig,i)=>{
                    const sigColors = {high:{bg:"rgba(200,0,10,0.08)",bd:"rgba(200,0,10,0.22)",c:C.red,icon:"🚨"},medium:{bg:"rgba(208,128,32,0.07)",bd:"rgba(208,128,32,0.2)",c:C.amber,icon:"⚠️"},info:{bg:"rgba(72,120,192,0.06)",bd:"rgba(72,120,192,0.18)",c:C.blue,icon:"ℹ️"}};
                    const sc = sigColors[sig.level]||sigColors.info;
                    return (
                      <div key={i} style={{background:sc.bg,border:`1px solid ${sc.bd}`,borderRadius:8,padding:"9px 13px",display:"flex",gap:10,alignItems:"flex-start"}}>
                        <span style={{fontSize:13,flexShrink:0,marginTop:1}}>{sc.icon}</span>
                        <div style={{flex:1}}><div style={{fontSize:11.5,color:sc.c,lineHeight:1.5}}>{sig.msg}</div></div>
                        <div style={{fontSize:8,fontWeight:700,color:sc.c,border:`1px solid ${sc.bd}`,borderRadius:4,padding:"2px 6px",flexShrink:0,textTransform:"uppercase",letterSpacing:"0.06em"}}>{sig.level}</div>
                      </div>
                    );
                  })}
                </div>
                {res.fraudSignals.filter(s=>s.level==="high").length>=2&&(
                  <div style={{marginTop:10,background:"rgba(200,0,10,0.06)",border:`1px solid rgba(200,0,10,0.2)`,borderRadius:8,padding:"9px 13px",fontSize:12,color:"#c05040",lineHeight:1.5}}>
                    <strong>⚠ UNDERWRITER NOTICE:</strong> Multiple high-severity fraud signals — senior underwriter sign-off required before proceeding.
                  </div>
                )}
              </div>
            )}
            {/* Risk Scorecard */}
            <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"16px 20px",marginBottom:11}}>
              <div style={{fontSize:9.5,fontWeight:700,color:C.muted,letterSpacing:"0.14em",textTransform:"uppercase",marginBottom:14}}>Risk Score Breakdown (90 pts)</div>
              {res.scorecard.map(sc=><ScoreBar key={sc.label} {...sc}/>)}
              <div style={{borderTop:`1px solid ${C.border}`,paddingTop:11,marginTop:4,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontSize:12,fontWeight:700,color:C.text}}>Total Score</span>
                <div style={{textAlign:"right"}}>
                  <span style={{fontFamily:"'IBM Plex Mono',monospace",fontWeight:700,fontSize:16,color:dm.c}}>{res.totalScore}</span>
                  <span style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:11,color:C.muted}}>/90</span>
                  {res.fraudSignals?.filter(s=>s.level==="high").length>0&&<div style={{fontSize:9,color:C.red,marginTop:1}}>includes fraud penalty</div>}
                </div>
              </div>
            </div>
            {/* MCA Stack */}
            {res.mcaPositions?.length>0&&(
              <div style={{background:"#0e0808",border:`1px solid #2a1414`,borderRadius:12,padding:"14px 18px",marginBottom:11}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                  <div style={{fontSize:9.5,fontWeight:700,color:C.red,letterSpacing:"0.12em",textTransform:"uppercase"}}>
                    ⚡ Active MCA Stack — {res.mcaPositions.length} Lender{res.mcaPositions.length>1?"s":""}
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:16,fontWeight:700,color:res.burdenPct>0.30?C.red:res.burdenPct>0.20?C.amber:C.green}}>{Math.round(res.burdenPct*100)}% DSR</div>
                    <div style={{fontSize:9,color:C.muted}}>${res.totalMonthlyMcaBurden.toLocaleString()}/mo of ${(+f.avgMonthly||0).toLocaleString()} revenue</div>
                  </div>
                </div>
                <div style={{display:"grid",gap:7}}>
                  {res.mcaPositions.map((pos,i)=>(
                    <div key={i} style={{background:"#0a0606",border:`1px solid #1f1010`,borderLeft:`3px solid ${pos.confidence==="high"?C.red:C.amber}`,borderRadius:8,padding:"10px 14px"}}>
                      <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                        <div style={{fontWeight:700,fontSize:13,color:C.white}}>{pos.lenderName}</div>
                        <div style={{display:"flex",gap:6,alignItems:"center"}}>
                          {pos.estimatedRemainingBalance>0&&<span style={{fontSize:10,color:C.amber,fontFamily:"'IBM Plex Mono',monospace"}}>~${pos.estimatedRemainingBalance.toLocaleString()} remaining</span>}
                          <div style={{fontSize:8,color:pos.confidence==="high"?C.red:C.amber,border:`1px solid currentColor`,borderRadius:4,padding:"2px 5px",fontWeight:700,letterSpacing:"0.06em",textTransform:"uppercase"}}>{pos.confidence}</div>
                        </div>
                      </div>
                      <div style={{display:"flex",gap:16,flexWrap:"wrap"}}>
                        <span style={{fontSize:10.5,color:C.muted}}><span style={{color:C.white,fontWeight:600}}>${(pos.debitAmount||0).toLocaleString()}</span> per {pos.frequency}</span>
                        <span style={{fontSize:10.5,color:C.muted}}><span style={{color:C.white,fontWeight:600}}>{pos.debitsPerMonth}×</span> per month</span>
                        <span style={{fontSize:10.5,color:"#e06060",fontWeight:700}}>${(pos.totalMonthlyBurden||0).toLocaleString()}/mo burden</span>
                        {pos.firstSeen&&<span style={{fontSize:9.5,color:"#3a3a3a"}}>since {pos.firstSeen}</span>}
                      </div>
                    </div>
                  ))}
                </div>
                {res.burdenPct>0.25&&(
                  <div style={{marginTop:10,padding:"9px 12px",background:"rgba(200,0,10,0.05)",border:`1px solid rgba(200,0,10,0.18)`,borderRadius:7,fontSize:11.5,color:"#c05040",lineHeight:1.5}}>
                    <strong>Underwriter note:</strong> Approval OK only if El Jay refinances at least one position OR comes in last with lower holdback that demonstrably improves merchant's net cash position.
                  </div>
                )}
              </div>
            )}
            {/* Lender Deposits */}
            {analysisData?.lenderDeposits?.length>0&&(
              <div style={{background:"#0c0e0a",border:`1px solid #1e2818`,borderLeft:`3px solid #e07820`,borderRadius:12,padding:"14px 18px",marginBottom:11}}>
                <div style={{fontSize:9.5,fontWeight:700,color:"#e07820",letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:12}}>
                  💰 Lender Deposits in Statement — {analysisData.lenderDeposits.length} Event{analysisData.lenderDeposits.length>1?"s":""}
                </div>
                <div style={{display:"grid",gap:7}}>
                  {analysisData.lenderDeposits.map((dep,i)=>{
                    const typeColors={MCA_FUNDING:{bg:"rgba(200,0,10,0.07)",bd:"rgba(200,0,10,0.2)",c:C.red,tag:"MCA"},LOAN_PROCEEDS:{bg:"rgba(72,120,192,0.07)",bd:"rgba(72,120,192,0.2)",c:C.blue,tag:"LOAN"},LINE_OF_CREDIT:{bg:"rgba(72,120,192,0.07)",bd:"rgba(72,120,192,0.2)",c:C.blue,tag:"LOC"},OTHER_LENDER:{bg:"rgba(208,128,32,0.07)",bd:"rgba(208,128,32,0.2)",c:C.amber,tag:"LENDER"}};
                    const tc=typeColors[dep.type]||typeColors.OTHER_LENDER;
                    return (
                      <div key={i} style={{background:tc.bg,border:`1px solid ${tc.bd}`,borderRadius:8,padding:"10px 14px",display:"grid",gridTemplateColumns:"1fr auto",gap:10,alignItems:"center"}}>
                        <div>
                          <div style={{display:"flex",gap:7,alignItems:"center",marginBottom:4}}>
                            <span style={{fontWeight:700,fontSize:13,color:C.white}}>{dep.lenderName}</span>
                            <span style={{fontSize:8,fontWeight:700,color:tc.c,border:`1px solid ${tc.bd}`,borderRadius:4,padding:"1px 5px",letterSpacing:"0.06em"}}>{tc.tag}</span>
                          </div>
                          <div style={{fontSize:10.5,color:"#504840",fontFamily:"'IBM Plex Mono',monospace"}}>{dep.description}</div>
                        </div>
                        <div style={{textAlign:"right",flexShrink:0}}>
                          <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:15,fontWeight:700,color:C.green}}>+${(dep.amount||0).toLocaleString()}</div>
                          <div style={{fontSize:10,color:C.muted,marginTop:2}}>{dep.depositDate}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div style={{marginTop:9,fontSize:11,color:"#504030",fontStyle:"italic",lineHeight:1.5}}>
                  These are inbound funding events — not repayments. Review for undisclosed liabilities, prior refinancing activity, or unreported MCA positions.
                </div>
              </div>
            )}
            {/* FEATURE 9: Competitive Intelligence */}
            {(analysisData?.lenderDeposits?.length>0||res?.mcaPositions?.length>0)&&(
              <div style={{background:"#0a0c14",border:`1px solid #1a1e30`,borderLeft:`3px solid ${C.blue}`,borderRadius:12,padding:"14px 18px",marginBottom:11}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                  <div style={{fontSize:9.5,fontWeight:700,color:C.blue,letterSpacing:"0.12em",textTransform:"uppercase"}}>
                    🎯 Competitive Intelligence
                  </div>
                  {!competingOffers && (
                    <button onClick={handleAnalyzeCompeting} disabled={analyzingCompeting} style={{padding:"7px 12px",background:analyzingCompeting?"#1a1a1a":"transparent",border:`1px solid ${C.blue}`,borderRadius:6,color:analyzingCompeting?C.muted:C.blue,fontSize:10.5,fontWeight:700,cursor:analyzingCompeting?"not-allowed":"pointer",letterSpacing:"0.05em"}}>
                      {analyzingCompeting ? "● Analyzing…" : "Analyze Competing Lenders →"}
                    </button>
                  )}
                </div>
                {competingOffers ? (
                  <div style={{fontSize:11.5,color:"#8098c0",lineHeight:1.5}}>
                    <div style={{marginBottom:10,color:C.white,fontStyle:"italic"}}>{competingOffers.summary}</div>
                    {competingOffers.lendersIdentified?.length>0 && (
                      <div style={{marginBottom:10}}>
                        <div style={{fontSize:9,color:C.muted,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:6}}>Lenders Identified</div>
                        {competingOffers.lendersIdentified.map((l,i)=>(
                          <div key={i} style={{marginBottom:6,padding:"7px 10px",background:"#080a12",border:`1px solid #131828`,borderRadius:6}}>
                            <div style={{fontWeight:700,color:C.white,fontSize:12}}>{l.name}</div>
                            <div style={{fontSize:10.5,color:C.muted,marginTop:2}}>{l.reputation} · typical {l.typicalFactor}</div>
                            {l.notes && <div style={{fontSize:10.5,color:"#5a7098",marginTop:2}}>{l.notes}</div>}
                          </div>
                        ))}
                      </div>
                    )}
                    {competingOffers.refinancingPattern && (
                      <div style={{marginBottom:8}}><strong style={{color:C.amber}}>Pattern:</strong> {competingOffers.refinancingPattern}</div>
                    )}
                    {competingOffers.estimatedRemainingObligations && (
                      <div style={{marginBottom:8}}><strong style={{color:C.amber}}>Est. remaining balance:</strong> {competingOffers.estimatedRemainingObligations}</div>
                    )}
                    {competingOffers.competitiveAdvantages?.length>0 && (
                      <div style={{marginBottom:8}}>
                        <div style={{fontSize:9,color:C.green,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:4}}>El Jay Advantages</div>
                        {competingOffers.competitiveAdvantages.map((a,i)=>(<div key={i} style={{color:"#6a9878",fontSize:11}}>✓ {a}</div>))}
                      </div>
                    )}
                    {competingOffers.competitiveRisks?.length>0 && (
                      <div style={{marginBottom:8}}>
                        <div style={{fontSize:9,color:C.red,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:4}}>Competitive Risks</div>
                        {competingOffers.competitiveRisks.map((r,i)=>(<div key={i} style={{color:"#c07060",fontSize:11}}>⚠ {r}</div>))}
                      </div>
                    )}
                    {competingOffers.recommendedPositioning && (
                      <div style={{marginTop:10,padding:"9px 12px",background:"rgba(72,120,192,0.06)",border:`1px solid rgba(72,120,192,0.2)`,borderRadius:7,color:"#8098c0"}}>
                        <strong style={{color:C.blue}}>Recommended positioning:</strong> {competingOffers.recommendedPositioning}
                      </div>
                    )}
                  </div>
                ) : (
                  <div style={{fontSize:11,color:C.muted,fontStyle:"italic"}}>
                    Click above to run web-search on the lenders in this merchant's history — returns reputation intel, typical terms, and how El Jay should position.
                  </div>
                )}
              </div>
            )}
            {/* Risk Flags */}
            {res.flags?.length>0&&(
              <div style={{background:"rgba(208,128,32,0.05)",border:`1px solid rgba(208,128,32,0.16)`,borderRadius:10,padding:"13px 17px",marginBottom:11}}>
                <div style={{fontSize:9.5,fontWeight:700,color:C.amber,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:9}}>⚑ Risk Flags ({res.flags.length})</div>
                {res.flags.map((fl,i)=>(
                  <div key={i} style={{display:"flex",gap:8,marginBottom:6,alignItems:"flex-start"}}>
                    <div style={{width:5,height:5,borderRadius:"50%",background:C.amber,marginTop:5,flexShrink:0}}/>
                    <span style={{fontSize:11.5,color:"#a07828",lineHeight:1.5}}>{fl}</span>
                  </div>
                ))}
              </div>
            )}
            {/* Stipulations */}
            {res.stips?.length>0&&(
              <div style={{background:"rgba(72,120,192,0.05)",border:`1px solid rgba(72,120,192,0.18)`,borderRadius:10,padding:"13px 17px",marginBottom:11}}>
                <div style={{fontSize:9.5,fontWeight:700,color:C.blue,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:9}}>📋 Required Stipulations ({res.stips.length})</div>
                {res.stips.map((st,i)=>(
                  <div key={i} style={{display:"flex",gap:9,marginBottom:8,alignItems:"flex-start"}}>
                    <div style={{width:14,height:14,border:`1.5px solid rgba(72,120,192,0.5)`,borderRadius:3,flexShrink:0,marginTop:2}}/>
                    <span style={{fontSize:11.5,color:"#6888b8",lineHeight:1.5}}>{st}</span>
                  </div>
                ))}
              </div>
            )}
            {/* Submit CTA */}
            {(res.decision==="APPROVE"||res.decision==="APPROVE_STIPS")&&(
              <div style={{background:"rgba(24,160,88,0.06)",border:`1px solid rgba(24,160,88,0.18)`,borderRadius:10,padding:"13px 18px",marginBottom:11}}>
                <div style={{fontSize:9.5,fontWeight:700,color:C.green,letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:4}}>✓ Ready to Submit to El Jay Capital</div>
                <div style={{fontSize:11.5,color:"#50a878",lineHeight:1.6}}>📧 Submissions@EljayCapital.com &nbsp;·&nbsp; CC Victor@EljayCapital.com &nbsp;·&nbsp; 📞 (929) 280-9636</div>
              </div>
            )}
            {/* ── DEAL MEMORY: Save + Pattern Insights ── */}
            <div style={{background:"#0a0c0a",border:`1px solid #1a241a`,borderLeft:`3px solid ${C.gold}`,borderRadius:12,padding:"16px 18px",marginBottom:11}}>
              <div style={{fontSize:9.5,fontWeight:700,color:C.gold,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:12}}>🧠 Deal Memory — Learn From This Deal</div>
              {!dealSaved ? (
                <>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
                    <div>
                      <label style={{fontSize:9,color:C.muted,letterSpacing:"0.1em",textTransform:"uppercase",display:"block",marginBottom:4}}>Funding Channel</label>
                      <select value={fundingChannel} onChange={e=>setFundingChannel(e.target.value)} style={{...sel,borderColor:"#2a2a1a"}}>
                        <option value="iso">ISO Submitted</option>
                        <option value="direct">Direct Merchant</option>
                        <option value="broker">Broker / Referral</option>
                      </select>
                    </div>
                    <div style={{display:"flex",alignItems:"flex-end"}}>
                      <div style={{fontSize:11,color:C.muted,lineHeight:1.5}}>Save this deal to El Jay's memory. The AI will learn from every funded deal + outcome over time.</div>
                    </div>
                  </div>
                  <button onClick={handleSaveDeal} disabled={savingDeal} style={{width:"100%",padding:"11px",background:savingDeal?"#1a1a1a":C.gold,border:"none",borderRadius:8,color:savingDeal?C.muted:"#000",fontWeight:700,fontSize:13,cursor:savingDeal?"not-allowed":"pointer",letterSpacing:"0.04em",display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
                    {savingDeal?<><span className="pulse">●</span> Saving to Memory...</>:"💾 Save Deal to Memory →"}
                  </button>
                </>
              ) : (
                <div>
                  <div style={{fontSize:12,color:C.green,marginBottom:10,display:"flex",alignItems:"center",gap:6}}>✓ Deal saved — {allDeals.length} total deal{allDeals.length!==1?"s":""} in memory · {allDeals.filter(d=>d.outcome!=="funded"&&d.outcome!=="pending").length} with outcomes recorded</div>
                  {/* Pattern Insights */}
                  {loadingInsights&&(
                    <div style={{background:"#0d0d08",border:`1px solid #252510`,borderRadius:8,padding:"12px 16px",display:"flex",alignItems:"center",gap:8}}>
                      <span className="pulse" style={{color:C.gold}}>●</span>
                      <span style={{fontSize:11.5,color:C.muted}}>Comparing against El Jay's deal history...</span>
                    </div>
                  )}
                  {patternInsights&&!loadingInsights&&(
                    <div style={{background:"#0d0d08",border:`1px solid #252510`,borderRadius:8,padding:"14px 16px"}}>
                      <div style={{fontSize:9,fontWeight:700,color:C.gold,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:10}}>AI Pattern Match — {patternInsights.similarDeals} Similar Deals in History</div>
                      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8,marginBottom:12}}>
                        {[
                          {l:"Similar Deals",v:patternInsights.similarDeals,c:C.white},
                          {l:"Paid Off Clean",v:patternInsights.similarPayoffs,c:C.green},
                          {l:"Defaulted",v:patternInsights.similarDefaults,c:C.red},
                          {l:"Prediction",v:patternInsights.predictedOutcome?.replace("_"," ").toUpperCase(),c:patternInsights.predictedOutcome==="likely_payoff"?C.green:patternInsights.predictedOutcome==="moderate_risk"?C.amber:C.red},
                        ].map(it=>(
                          <div key={it.l} style={{textAlign:"center",background:"#0a0a0a",border:`1px solid #1a1a1a`,borderRadius:6,padding:"8px"}}>
                            <div style={{fontSize:8,color:C.muted,textTransform:"uppercase",marginBottom:2}}>{it.l}</div>
                            <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:12,fontWeight:700,color:it.c}}>{it.v}</div>
                          </div>
                        ))}
                      </div>
                      {patternInsights.learningInsight&&(
                        <div style={{fontSize:11.5,color:"#909070",fontStyle:"italic",lineHeight:1.55,marginBottom:patternInsights.patternWarnings?.length>0?10:0}}>"{patternInsights.learningInsight}"</div>
                      )}
                      {patternInsights.patternWarnings?.length>0&&(
                        <div style={{marginBottom:patternInsights.patternStrengths?.length>0?8:0}}>
                          {patternInsights.patternWarnings.map((w,i)=><div key={i} style={{display:"flex",gap:6,marginBottom:4}}><span style={{color:C.amber,fontSize:10}}>⚠</span><span style={{fontSize:11,color:"#906820",lineHeight:1.4}}>{w}</span></div>)}
                        </div>
                      )}
                      {patternInsights.patternStrengths?.length>0&&(
                        <div>
                          {patternInsights.patternStrengths.map((s,i)=><div key={i} style={{display:"flex",gap:6,marginBottom:4}}><span style={{color:C.green,fontSize:10}}>✓</span><span style={{fontSize:11,color:"#508050",lineHeight:1.4}}>{s}</span></div>)}
                        </div>
                      )}
                      {patternInsights.recommendedAdjustment&&(
                        <div style={{marginTop:10,padding:"8px 12px",background:"rgba(200,160,64,0.06)",border:`1px solid rgba(200,160,64,0.18)`,borderRadius:6,fontSize:11,color:C.gold,lineHeight:1.5}}>
                          💡 <strong>Recommended adjustment:</strong> {patternInsights.recommendedAdjustment}
                        </div>
                      )}
                    </div>
                  )}
                  {allDeals.filter(d=>d.outcome!=="funded"&&d.outcome!=="pending").length<3&&!loadingInsights&&(
                    <div style={{fontSize:11,color:"#404030",fontStyle:"italic"}}>Pattern insights unlock after 3+ deals have recorded outcomes. Record outcomes in Deal Memory to activate.</div>
                  )}
                </div>
              )}
            </div>
            {/* ── DEAL ADVISOR CHAT ── */}
            <div style={{background:"#0a0a10",border:`1px solid #1a1a2e`,borderLeft:`3px solid #5060c0`,borderRadius:12,padding:"16px 18px",marginBottom:11}}>
              {/* Header */}
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:12}}>
                <div>
                  <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:3}}>
                    <div style={{fontSize:9.5,fontWeight:700,color:"#7080d0",letterSpacing:"0.12em",textTransform:"uppercase"}}>🧠 Deal Advisor</div>
                    <div style={{fontSize:8,color:"#304060",letterSpacing:"0.08em",textTransform:"uppercase",padding:"2px 6px",border:"1px solid #202040",borderRadius:4}}>OPUS</div>
                  </div>
                  {/* Muscle pills */}
                  <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                    {[
                      {key:"gemini",icon:"🌐",label:"GEMINI",color:"#4285f4", active: chatStage==="gemini"},
                      {key:"grok",  icon:"⚡",label:"GROK",  color:"#1d9bf0", active: chatStage==="grok"},
                    ].map(m=>(
                      <div key={m.key} style={{display:"flex",alignItems:"center",gap:4,padding:"2px 8px",borderRadius:12,background:m.active?`${m.color}18`:"#0a0a0a",border:`1px solid ${m.active?m.color+"44":"#1a1a1a"}`,transition:"all 0.3s"}}>
                        <span style={{fontSize:10}}>{m.icon}</span>
                        <span style={{fontSize:8,fontWeight:700,color:m.active?m.color:"#303040",letterSpacing:"0.08em"}}>{m.label}</span>
                        {m.active&&<span style={{width:5,height:5,borderRadius:"50%",background:m.color,display:"inline-block",animation:"pulse 0.8s infinite"}}/>}
                      </div>
                    ))}
                  </div>
                </div>
                {chatMessages.length>0&&(
                  <button onClick={()=>setChatMessages([])} style={{fontSize:10,color:C.muted,background:"transparent",border:`1px solid #222`,borderRadius:5,padding:"3px 9px",cursor:"pointer"}}>Clear</button>
                )}
              </div>
              {/* Messages */}
              <div style={{maxHeight:360,overflowY:"auto",marginBottom:11,display:"flex",flexDirection:"column",gap:8}}>
                {chatMessages.length===0&&(
                  <div style={{padding:"16px 0",textAlign:"center"}}>
                    <div style={{fontSize:11,color:"#303040",marginBottom:10}}>Opus + Gemini web search + Grok social intel — ask anything about this deal</div>
                    <div style={{display:"flex",gap:6,flexWrap:"wrap",justifyContent:"center"}}>
                      {["Should I counter this deal?","What's the biggest risk here?","What are other MCA lenders doing right now?","Is this stacking safe?","What stips do I need?"].map(q=>(
                        <button key={q} onClick={()=>setChatInput(q)} style={{fontSize:10.5,padding:"5px 10px",background:"#0f0f18",border:`1px solid #20203a`,borderRadius:5,color:"#6070b0",cursor:"pointer",fontFamily:"inherit"}}>{q}</button>
                      ))}
                    </div>
                  </div>
                )}
                {chatMessages.map((msg,i)=>(
                  <ChatBubble key={i} msg={msg}/>
                ))}
                {chatLoading&&(
                  <div style={{alignSelf:"flex-start",background:"#0f0f18",border:`1px solid #1a1a2e`,borderRadius:"10px 10px 10px 2px",padding:"10px 13px"}}>
                    <div style={{fontSize:8,color:"#5060c0",letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:5,fontWeight:700}}>🧠 OPUS ADVISOR</div>
                    <div style={{display:"flex",gap:6,alignItems:"center"}}>
                      <span className="pulse" style={{color:"#5060c0",fontSize:14}}>●</span>
                      <span style={{fontSize:11,color:C.muted}}>
                        {chatStage==="routing"?"Brain routing query...":
                         chatStage==="gemini"?"🌐 Gemini searching web...":
                         chatStage==="grok"?"⚡ Grok reading social pulse...":
                         "🧠 Opus synthesizing..."}
                      </span>
                    </div>
                  </div>
                )}
                <div ref={chatEndRef}/>
              </div>
              {/* Input */}
              <div style={{display:"flex",gap:8}}>
                <input
                  value={chatInput}
                  onChange={e=>setChatInput(e.target.value)}
                  onKeyDown={e=>e.key==="Enter"&&!e.shiftKey&&sendChatMessage()}
                  placeholder="Ask Opus — web search and social intel auto-activate when needed..."
                  style={{...inp,flex:1,background:"#0d0d18",borderColor:"#252540",color:C.white}}
                  disabled={chatLoading}
                />
                <button
                  onClick={sendChatMessage}
                  disabled={chatLoading||!chatInput.trim()}
                  style={{padding:"9px 18px",background:chatLoading||!chatInput.trim()?"#111":"#3040a0",border:"none",borderRadius:8,color:chatLoading||!chatInput.trim()?C.muted:"#c0c8ff",fontWeight:700,fontSize:12,cursor:chatLoading||!chatInput.trim()?"not-allowed":"pointer",letterSpacing:"0.04em",whiteSpace:"nowrap",fontFamily:"inherit"}}>
                  {chatLoading?"...":"Send →"}
                </button>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
              <button onClick={()=>{setView("upload");setRes(null);setUploadedFiles([]);setAnalysisData(null);setAiFilledFields({});}} style={{padding:"12px",background:"transparent",border:`1px solid ${C.border}`,borderRadius:9,color:C.muted,fontSize:12,cursor:"pointer"}}>← New Deal</button>
              <button onClick={()=>setView("form")} style={{padding:"12px",background:"transparent",border:`1px solid ${C.border}`,borderRadius:9,color:C.muted,fontSize:12,cursor:"pointer"}}>← Edit Deal</button>
            </div>
            {/* FEATURE 8: Offer Letter Modal (screen view) */}
            {showOfferLetter && res && res.decision!=="DECLINE" && (
              <div onClick={()=>setShowOfferLetter(false)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.85)",zIndex:1000,display:"flex",alignItems:"flex-start",justifyContent:"center",overflowY:"auto",padding:"40px 20px"}}>
                <div onClick={e=>e.stopPropagation()} style={{background:"#fff",color:"#000",maxWidth:720,width:"100%",borderRadius:6,padding:"40px 44px",fontFamily:"Georgia, serif",position:"relative",boxShadow:"0 20px 60px rgba(0,0,0,0.6)"}}>
                  <button onClick={()=>setShowOfferLetter(false)} style={{position:"absolute",top:12,right:12,background:"#eee",border:"none",width:28,height:28,borderRadius:"50%",cursor:"pointer",fontSize:14,color:"#333"}}>✕</button>
                  <div style={{textAlign:"center",marginBottom:20}}>
                    <div style={{fontSize:22,fontWeight:700,letterSpacing:"0.05em"}}>EL JAY CAPITAL</div>
                    <div style={{fontSize:10,color:"#666",letterSpacing:"0.12em",marginTop:4}}>MERCHANT CASH ADVANCE · APPROVAL TERM SHEET</div>
                    <div style={{borderTop:"2px solid #000",marginTop:12}}/>
                  </div>
                  <div style={{fontSize:11,color:"#666",marginBottom:18}}>Date issued: {new Date().toLocaleDateString("en-US",{year:"numeric",month:"long",day:"numeric"})}</div>
                  <h2 style={{fontSize:14,marginBottom:8,borderBottom:"1px solid #ccc",paddingBottom:4}}>Merchant</h2>
                  <table style={{width:"100%",borderCollapse:"collapse",marginBottom:14,fontSize:12}}>
                    <tbody>
                      <tr><td style={{padding:"5px 0",width:"40%",color:"#555"}}>Business</td><td style={{padding:"5px 0",fontWeight:600}}>{f.businessName||"—"}</td></tr>
                      <tr><td style={{padding:"5px 0",color:"#555"}}>State</td><td style={{padding:"5px 0"}}>{f.state||"—"}</td></tr>
                      <tr><td style={{padding:"5px 0",color:"#555"}}>Industry</td><td style={{padding:"5px 0"}}>{f.industry}</td></tr>
                    </tbody>
                  </table>
                  <h2 style={{fontSize:14,marginBottom:8,borderBottom:"1px solid #ccc",paddingBottom:4}}>Approved Terms</h2>
                  <table style={{width:"100%",borderCollapse:"collapse",marginBottom:14,fontSize:12}}>
                    <tbody>
                      <tr><td style={{padding:"5px 0",width:"40%",color:"#555"}}>Advance Amount</td><td style={{padding:"5px 0",fontWeight:700}}>${res.approvedAdvance.toLocaleString()}</td></tr>
                      <tr><td style={{padding:"5px 0",color:"#555"}}>Factor Rate</td><td style={{padding:"5px 0"}}>{res.factorRate}×</td></tr>
                      <tr><td style={{padding:"5px 0",color:"#555"}}>Total Payback</td><td style={{padding:"5px 0",fontWeight:700}}>${res.payback.toLocaleString()}</td></tr>
                      <tr><td style={{padding:"5px 0",color:"#555"}}>Term</td><td style={{padding:"5px 0"}}>{res.termDays} business days</td></tr>
                      <tr><td style={{padding:"5px 0",color:"#555"}}>Daily ACH Payment</td><td style={{padding:"5px 0",fontWeight:700}}>${res.dailyPayment.toLocaleString()} · Mon–Fri only (22×/mo)</td></tr>
                      <tr><td style={{padding:"5px 0",color:"#555"}}>Est. Weekly</td><td style={{padding:"5px 0"}}>${res.weeklyPayment.toLocaleString()}</td></tr>
                      <tr><td style={{padding:"5px 0",color:"#555"}}>Position</td><td style={{padding:"5px 0"}}>{f.position}</td></tr>
                      <tr><td style={{padding:"5px 0",color:"#555"}}>Risk Score</td><td style={{padding:"5px 0"}}>{res.totalScore}/90 · {res.riskBand}</td></tr>
                      <tr><td style={{padding:"5px 0",color:"#555"}}>Decision</td><td style={{padding:"5px 0",fontWeight:700}}>{dm.label}</td></tr>
                    </tbody>
                  </table>
                  {res.stips?.length>0 && (<>
                    <h2 style={{fontSize:14,marginBottom:8,borderBottom:"1px solid #ccc",paddingBottom:4}}>Stipulations Required Before Funding</h2>
                    <ul style={{fontSize:12,lineHeight:1.6,paddingLeft:18,marginBottom:14}}>
                      {res.stips.map((st,i)=>(<li key={i} style={{marginBottom:3}}>{st}</li>))}
                    </ul>
                  </>)}
                  {res.protectiveConditions?.length>0 && (<>
                    <h2 style={{fontSize:14,marginBottom:8,borderBottom:"1px solid #ccc",paddingBottom:4}}>Protective Conditions</h2>
                    <ul style={{fontSize:12,lineHeight:1.6,paddingLeft:18,marginBottom:14}}>
                      {res.protectiveConditions.map((pc,i)=>(<li key={i} style={{marginBottom:3}}>{pc}</li>))}
                    </ul>
                  </>)}
                  <div style={{marginTop:18,paddingTop:12,borderTop:"1px solid #ccc",fontSize:10,color:"#777",lineHeight:1.55}}>
                    This term sheet is a non-binding indication of credit. Funding is contingent on satisfactory completion of all stipulations, receipt of executed documents, and El Jay Capital's final underwriting review. Factor rate is not an annualized interest rate. ACH debits pull Monday through Friday on business days only. Merchant acknowledges that the Merchant Cash Advance is a purchase of future receivables, not a loan.
                  </div>
                  <div className="no-print" style={{marginTop:18,display:"flex",gap:10,justifyContent:"flex-end"}}>
                    <button onClick={()=>setShowOfferLetter(false)} style={{padding:"9px 16px",background:"#eee",border:"1px solid #ccc",borderRadius:5,cursor:"pointer",fontSize:12}}>Close</button>
                    <button onClick={()=>window.print()} style={{padding:"9px 16px",background:"#000",color:"#fff",border:"none",borderRadius:5,cursor:"pointer",fontSize:12,fontWeight:700}}>🖨 Print</button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
        {/* FEATURE 8: Print-only offer letter div (rendered invisibly until @media print) */}
        {res && res.decision!=="DECLINE" && (
          <div className="offer-letter-print">
            <h1>EL JAY CAPITAL</h1>
            <div style={{fontSize:"10pt",color:"#555",marginBottom:"12pt"}}>MERCHANT CASH ADVANCE — APPROVAL TERM SHEET · {new Date().toLocaleDateString()}</div>
            <h2>Merchant</h2>
            <table>
              <tbody>
                <tr><td style={{width:"35%"}}>Business</td><td><strong>{f.businessName||"—"}</strong></td></tr>
                <tr><td>State</td><td>{f.state||"—"}</td></tr>
                <tr><td>Industry</td><td>{f.industry}</td></tr>
              </tbody>
            </table>
            <h2>Approved Terms</h2>
            <table>
              <tbody>
                <tr><td style={{width:"35%"}}>Advance Amount</td><td><strong>${res.approvedAdvance?.toLocaleString()}</strong></td></tr>
                <tr><td>Factor Rate</td><td>{res.factorRate}×</td></tr>
                <tr><td>Total Payback</td><td><strong>${res.payback?.toLocaleString()}</strong></td></tr>
                <tr><td>Term</td><td>{res.termDays} business days</td></tr>
                <tr><td>Daily ACH Payment</td><td><strong>${res.dailyPayment?.toLocaleString()}</strong> · Mon–Fri only</td></tr>
                <tr><td>Position</td><td>{f.position}</td></tr>
                <tr><td>Risk Score</td><td>{res.totalScore}/90 · {res.riskBand}</td></tr>
                <tr><td>Decision</td><td><strong>{dm?.label}</strong></td></tr>
              </tbody>
            </table>
            {res.stips?.length>0 && (<>
              <h2>Stipulations</h2>
              <ul>{res.stips.map((st,i)=>(<li key={i}>{st}</li>))}</ul>
            </>)}
            {res.protectiveConditions?.length>0 && (<>
              <h2>Protective Conditions</h2>
              <ul>{res.protectiveConditions.map((pc,i)=>(<li key={i}>{pc}</li>))}</ul>
            </>)}
            <div style={{marginTop:"14pt",paddingTop:"8pt",borderTop:"1px solid #888",fontSize:"9pt",color:"#555"}}>
              This term sheet is a non-binding indication of credit. Funding contingent on satisfactory completion of stipulations and El Jay Capital's final underwriting review. Factor rate is not an annualized interest rate. ACH pulls Mon–Fri business days only.
            </div>
          </div>
        )}
        {/* ── DEAL MEMORY VIEW ── */}
        {view==="memory" && (
          <div className="fade">
            <div style={{marginBottom:20,display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
              <div>
                <h1 style={{fontSize:22,fontWeight:700,color:C.white}}>🧠 Deal Memory</h1>
                <p style={{color:C.muted,marginTop:4,fontSize:13}}>El Jay Capital's proprietary learning database. Every deal teaches the AI what pays and what doesn't.</p>
              </div>
              <button onClick={()=>setView(res?"result":"upload")} style={{background:"transparent",border:`1px solid ${C.border}`,borderRadius:7,color:C.muted,fontSize:11,padding:"6px 12px",cursor:"pointer"}}>← Back</button>
            </div>
            {/* Stats overview */}
            {dealStats&&dealStats.totalDeals>0 ? (
              <>
                <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10,marginBottom:14}}>
                  {[
                    {l:"Total Deals",v:dealStats.totalDeals,c:C.white},
                    {l:"Defaults",v:dealStats.defaults,c:dealStats.defaults>0?C.red:C.green,sub:dealStats.totalDeals>0?`${Math.round((dealStats.defaults/dealStats.totalDeals)*100)}% default rate`:""},
                    {l:"Early Payoffs",v:dealStats.earlyPayoffs,c:C.green,sub:"paid clean"},
                    {l:"Outcomes Recorded",v:allDeals.filter(d=>d.outcome&&d.outcome!=="funded").length,c:C.muted,sub:`of ${dealStats.totalDeals} deals`},
                  ].map(it=>(
                    <div key={it.l} style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:10,padding:"14px 16px",textAlign:"center"}}>
                      <div style={{fontSize:8.5,color:C.muted,textTransform:"uppercase",letterSpacing:"0.1em",marginBottom:5}}>{it.l}</div>
                      <div style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:22,fontWeight:700,color:it.c}}>{it.v}</div>
                      {it.sub&&<div style={{fontSize:9.5,color:C.muted,marginTop:2}}>{it.sub}</div>}
                    </div>
                  ))}
                </div>
                {/* Score range performance */}
                {dealStats.scoreRanges&&Object.keys(dealStats.scoreRanges).length>0&&(
                  <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"16px 18px",marginBottom:14}}>
                    <div style={{fontSize:9.5,fontWeight:700,color:C.muted,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:14}}>Score Range Performance</div>
                    {Object.entries(dealStats.scoreRanges).sort((a,b)=>b[0].localeCompare(a[0])).map(([range,data])=>{
                      const defRate = data.total>0?data.defaults/data.total:0;
                      const payRate = data.total>0?data.payoffs/data.total:0;
                      return (
                        <div key={range} style={{marginBottom:12}}>
                          <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                            <span style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:11,color:C.text}}>Score {range}</span>
                            <span style={{fontSize:10.5,color:C.muted}}>{data.total} deals · <span style={{color:C.red}}>{data.defaults} defaults ({Math.round(defRate*100)}%)</span> · <span style={{color:C.green}}>{data.payoffs} payoffs ({Math.round(payRate*100)}%)</span></span>
                          </div>
                          <div style={{background:"#1a1a1a",borderRadius:3,height:6,overflow:"hidden",position:"relative"}}>
                            <div style={{position:"absolute",left:0,top:0,height:"100%",width:`${payRate*100}%`,background:C.green,borderRadius:3}}/>
                            <div style={{position:"absolute",right:0,top:0,height:"100%",width:`${defRate*100}%`,background:C.red,borderRadius:3}}/>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
                {/* Industry performance */}
                {dealStats.industries&&Object.keys(dealStats.industries).length>0&&(
                  <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"16px 18px",marginBottom:14}}>
                    <div style={{fontSize:9.5,fontWeight:700,color:C.muted,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:12}}>Industry Performance</div>
                    <div style={{display:"grid",gap:8}}>
                      {Object.entries(dealStats.industries).sort((a,b)=>b[1].total-a[1].total).map(([ind,data])=>{
                        const defRate = data.total>0?Math.round((data.defaults/data.total)*100):0;
                        const color = defRate>=30?C.red:defRate>=15?C.amber:C.green;
                        return (
                          <div key={ind} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 12px",background:"#0a0a0a",border:`1px solid #1a1a1a`,borderLeft:`3px solid ${color}`,borderRadius:7}}>
                            <span style={{fontSize:12,color:C.text}}>{ind}</span>
                            <div style={{display:"flex",gap:14,alignItems:"center"}}>
                              <span style={{fontSize:10.5,color:C.muted}}>{data.total} deal{data.total!==1?"s":""}</span>
                              <span style={{fontFamily:"'IBM Plex Mono',monospace",fontSize:11,fontWeight:700,color}}>{defRate}% default</span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"40px 24px",textAlign:"center",marginBottom:14}}>
                <div style={{fontSize:32,marginBottom:12}}>🧠</div>
                <div style={{fontSize:15,fontWeight:600,color:C.white,marginBottom:6}}>No deals in memory yet</div>
                <div style={{fontSize:12.5,color:C.muted,maxWidth:380,margin:"0 auto",lineHeight:1.6}}>Run your first underwriting decision and save it to memory. The AI will learn from every deal — what paid off, what defaulted, which industries burned you, and which channels perform best.</div>
              </div>
            )}
            {/* Deal list */}
            {allDeals.length>0&&(
              <div style={{background:C.card,border:`1px solid ${C.border}`,borderRadius:12,padding:"16px 18px"}}>
                <div style={{fontSize:9.5,fontWeight:700,color:C.muted,letterSpacing:"0.12em",textTransform:"uppercase",marginBottom:12}}>Deal Log ({allDeals.length})</div>
                <div style={{display:"grid",gap:8,maxHeight:480,overflowY:"auto"}}>
                  {allDeals.map((deal,i)=>{
                    const outcomeColor = deal.outcome==="default"?C.red:deal.outcome==="early_payoff"||deal.outcome==="clean_refi"?C.green:deal.outcome==="funded"?C.blue:C.muted;
                    const outcomeLabel = {funded:"FUNDED",default:"DEFAULTED",early_payoff:"EARLY PAYOFF",clean_refi:"CLEAN REFI",declined:"DECLINED",pending:"PENDING"}[deal.outcome]||deal.outcome?.toUpperCase()||"FUNDED";
                    const missedCount = (deal.missedPayments||[]).length;
                    const dealIdStr = deal.id||`deal:${deal.timestamp}`;
                    return (
                      <div key={i} style={{background:"#0a0a0a",border:`1px solid ${missedCount>0?"rgba(200,0,10,0.3)":"#1a1a1a"}`,borderRadius:8,padding:"11px 14px",display:"grid",gridTemplateColumns:"1fr auto",gap:8,alignItems:"start"}}>
                        <div>
                          <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:5,flexWrap:"wrap"}}>
                            <span style={{fontWeight:700,fontSize:13,color:C.white}}>{deal.businessName}</span>
                            <span style={{fontSize:8.5,color:outcomeColor,border:`1px solid ${outcomeColor}`,borderRadius:4,padding:"1px 5px",fontWeight:700,letterSpacing:"0.06em"}}>{outcomeLabel}</span>
                            {deal.fraudSignalCount>0&&<span style={{fontSize:8.5,color:C.red,border:`1px solid rgba(200,0,10,0.3)`,borderRadius:4,padding:"1px 5px"}}>🚨 {deal.fraudSignalCount}</span>}
                            {/* FEATURE 10: missed payment badge */}
                            {missedCount>0&&<span style={{fontSize:8.5,color:C.red,background:"rgba(200,0,10,0.12)",border:`1px solid rgba(200,0,10,0.4)`,borderRadius:4,padding:"1px 5px",fontWeight:700}}>⚠ {missedCount} MISSED</span>}
                          </div>
                          <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
                            <span style={{fontSize:10.5,color:C.muted}}>{deal.industry}</span>
                            <span style={{fontSize:10.5,color:C.muted}}>${(deal.avgMonthly||0).toLocaleString()}/mo rev</span>
                            <span style={{fontSize:10.5,color:C.muted}}>Score: <span style={{color:deal.score>=65?C.green:deal.score>=50?C.amber:C.red,fontWeight:600}}>{deal.score}</span></span>
                            <span style={{fontSize:10.5,color:C.muted}}>${(deal.advanceAmount||0).toLocaleString()} advance</span>
                            <span style={{fontSize:10.5,color:C.muted,textTransform:"capitalize"}}>{deal.channel}</span>
                            <span style={{fontSize:10.5,color:"#333"}}>{deal.dateStr}</span>
                          </div>
                          {/* FEATURE 10: recent missed payment dates */}
                          {missedCount>0 && (
                            <div style={{marginTop:5,fontSize:10,color:"#c06050"}}>
                              Recent: {deal.missedPayments.slice(-3).map((m,j)=>(
                                <span key={j} style={{marginRight:8}}>{new Date(m.date).toLocaleDateString()}{m.note && m.note!=="Payment missed"?` (${m.note})`:""}</span>
                              ))}
                            </div>
                          )}
                          {deal.outcomeNotes&&<div style={{marginTop:4,fontSize:10.5,color:"#505040",fontStyle:"italic"}}>{deal.outcomeNotes}</div>}
                        </div>
                        <div style={{display:"flex",flexDirection:"column",gap:4}}>
                          <button
                            onClick={()=>{setOutcomeModal({dealId:dealIdStr,businessName:deal.businessName});setOutcomeForm({outcome:deal.outcome||"",notes:deal.outcomeNotes||""});}}
                            style={{background:"transparent",border:`1px solid #2a2a2a`,borderRadius:6,color:C.muted,fontSize:10,padding:"4px 9px",cursor:"pointer",whiteSpace:"nowrap"}}>
                            {deal.outcome==="funded"?"Record Outcome":"Update"}
                          </button>
                          {/* FEATURE 10: missed payment button (only for funded/pending) */}
                          {(deal.outcome==="funded"||deal.outcome==="pending"||!deal.outcome) && (
                            <button
                              onClick={()=>{setMissedPaymentModal({dealId:dealIdStr,businessName:deal.businessName});setMissedPaymentNote("");}}
                              style={{background:"transparent",border:`1px solid rgba(200,0,10,0.4)`,borderRadius:6,color:C.red,fontSize:10,padding:"4px 9px",cursor:"pointer",whiteSpace:"nowrap",fontWeight:700}}>
                              ⚠ Missed Payment
                            </button>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        )}
        {/* ── OUTCOME MODAL ── */}
        {outcomeModal&&(
          <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:999,padding:20}}>
            <div style={{background:"#111",border:`1px solid #2a2a2a`,borderRadius:14,padding:"24px",maxWidth:440,width:"100%"}}>
              <div style={{fontSize:14,fontWeight:700,color:C.white,marginBottom:4}}>Record Deal Outcome</div>
              <div style={{fontSize:11.5,color:C.muted,marginBottom:18}}>{outcomeModal.businessName}</div>
              <div style={{marginBottom:14}}>
                <label style={{fontSize:9,color:C.muted,letterSpacing:"0.1em",textTransform:"uppercase",display:"block",marginBottom:6}}>Outcome</label>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8}}>
                  {[{v:"early_payoff",l:"✓ Early Payoff",c:C.green},{v:"clean_refi",l:"✓ Clean Refi",c:C.green},{v:"default",l:"✗ Default",c:C.red},{v:"declined",l:"— Declined",c:C.muted}].map(opt=>(
                    <button key={opt.v} onClick={()=>setOutcomeForm(p=>({...p,outcome:opt.v}))} style={{padding:"10px",background:outcomeForm.outcome===opt.v?`rgba(${opt.c==="#18a058"?"24,160,88":opt.c==="#c8000a"?"200,0,10":"80,80,80"},0.15)`:"#0a0a0a",border:`1px solid ${outcomeForm.outcome===opt.v?opt.c:"#2a2a2a"}`,borderRadius:7,color:outcomeForm.outcome===opt.v?opt.c:C.muted,fontSize:12,fontWeight:600,cursor:"pointer"}}>
                      {opt.l}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{marginBottom:18}}>
                <label style={{fontSize:9,color:C.muted,letterSpacing:"0.1em",textTransform:"uppercase",display:"block",marginBottom:6}}>Notes (optional)</label>
                <textarea value={outcomeForm.notes} onChange={e=>setOutcomeForm(p=>({...p,notes:e.target.value}))} placeholder="What happened? Industry notes, warning signs missed, what you'd do differently..." rows={3} style={{...inp,resize:"vertical",fontFamily:"'DM Sans',sans-serif",fontSize:12.5}}/>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                <button onClick={()=>setOutcomeModal(null)} style={{padding:"11px",background:"transparent",border:`1px solid #2a2a2a`,borderRadius:8,color:C.muted,fontSize:12,cursor:"pointer"}}>Cancel</button>
                <button onClick={handleUpdateOutcome} disabled={!outcomeForm.outcome||updatingOutcome} style={{padding:"11px",background:outcomeForm.outcome?C.gold:"#1a1a1a",border:"none",borderRadius:8,color:outcomeForm.outcome?"#000":C.muted,fontWeight:700,fontSize:12,cursor:outcomeForm.outcome&&!updatingOutcome?"pointer":"not-allowed"}}>
                  {updatingOutcome?"Saving...":"Save Outcome →"}
                </button>
              </div>
            </div>
          </div>
        )}
        {/* FEATURE 10: Missed Payment Modal */}
        {missedPaymentModal && (
          <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.8)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:999,padding:20}}>
            <div style={{background:"#111",border:`1px solid rgba(200,0,10,0.4)`,borderRadius:14,padding:"24px",maxWidth:440,width:"100%"}}>
              <div style={{fontSize:14,fontWeight:700,color:C.red,marginBottom:4}}>⚠ Record Missed Payment</div>
              <div style={{fontSize:11.5,color:C.muted,marginBottom:18}}>{missedPaymentModal.businessName}</div>
              <div style={{marginBottom:18}}>
                <label style={{fontSize:9,color:C.muted,letterSpacing:"0.1em",textTransform:"uppercase",display:"block",marginBottom:6}}>Note (optional)</label>
                <textarea
                  value={missedPaymentNote}
                  onChange={e=>setMissedPaymentNote(e.target.value)}
                  placeholder="NSF, account closed, ACH returned, merchant contacted, etc."
                  rows={3}
                  style={{...inp,resize:"vertical",fontFamily:"'DM Sans',sans-serif",fontSize:12.5}}/>
              </div>
              <div style={{fontSize:10.5,color:C.muted,marginBottom:14,lineHeight:1.5,fontStyle:"italic"}}>
                Recording this will fire a browser notification and log the miss against this deal. Use this to track early-warning signals on your portfolio.
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                <button onClick={()=>{setMissedPaymentModal(null);setMissedPaymentNote("");}} style={{padding:"11px",background:"transparent",border:`1px solid #2a2a2a`,borderRadius:8,color:C.muted,fontSize:12,cursor:"pointer"}}>Cancel</button>
                <button onClick={handleRecordMissedPayment} disabled={recordingMissed} style={{padding:"11px",background:C.red,border:"none",borderRadius:8,color:"#fff",fontWeight:700,fontSize:12,cursor:recordingMissed?"not-allowed":"pointer"}}>
                  {recordingMissed?"Saving...":"Record Missed Payment →"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}