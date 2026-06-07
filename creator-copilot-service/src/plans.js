"use strict";

const PLANS = Object.freeze({
  trial: Object.freeze({
    id: "trial",
    name: "Trial",
    monthlyRequests: 100,
    maxSeats: 1
  }),
  creator: Object.freeze({
    id: "creator",
    name: "Creator",
    monthlyRequests: 3000,
    maxSeats: 1
  }),
  pro: Object.freeze({
    id: "pro",
    name: "Pro",
    monthlyRequests: 10000,
    maxSeats: 1
  }),
  agency: Object.freeze({
    id: "agency",
    name: "Agency",
    monthlyRequests: 50000,
    maxSeats: 10
  })
});

function getPlan(plans, planId) {
  const plan = plans[String(planId || "").trim().toLowerCase()];
  if (!plan) {
    const error = new Error(`Unknown plan: ${planId || "missing"}`);
    error.statusCode = 400;
    error.code = "invalid_plan";
    throw error;
  }
  return plan;
}

module.exports = {
  PLANS,
  getPlan
};
