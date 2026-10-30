import { zibalHandler } from './zibal.js';

// Zibal's sandbox (https://docs.zibal.ir, "حساب تستی"). The same
// wire protocol and hosts as live Zibal with the merchant "zibal", which
// Zibal keeps for testing: its start page offers "pay" and "cancel", every
// payment "succeeds" and no money moves. Nothing is stored for it: the
// merchant is always "zibal", whatever the Providers screen holds.
export const zibalTestProvider = zibalHandler('zibal_test', true);
