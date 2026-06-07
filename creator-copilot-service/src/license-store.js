"use strict";

const { createHmac, randomBytes, randomUUID } = require("node:crypto");
const { mkdir, readFile, rename, writeFile } = require("node:fs/promises");
const path = require("node:path");
const { PLANS, getPlan } = require("./plans");

const ACTIVE_STATUSES = new Set(["active", "trialing"]);
const LICENSE_STATUSES = new Set(["active", "trialing", "past_due", "canceled", "revoked"]);

class LicenseStore {
  constructor({
    filePath,
    hashSecret,
    plans = PLANS,
    now = () => new Date()
  }) {
    if (!filePath) throw new Error("License store file path is required");
    if (!hashSecret) throw new Error("License hash secret is required");
    this.filePath = path.resolve(filePath);
    this.hashSecret = hashSecret;
    this.plans = plans;
    this.now = now;
    this.data = null;
    this.queue = Promise.resolve();
  }

  async initialize() {
    return this.#runExclusive(async () => {
      if (this.data) return;
      await mkdir(path.dirname(this.filePath), { recursive: true });
      try {
        const raw = await readFile(this.filePath, "utf8");
        this.data = normalizeData(JSON.parse(raw));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        this.data = normalizeData({});
        await this.#persist();
      }
    });
  }

  async createLicense(input = {}) {
    return this.#mutate(() => this.#createLicenseRecord(input));
  }

  async listLicenses() {
    return this.#read(() =>
      Object.values(this.data.licenses)
        .map((license) => publicLicense(license, this.plans, this.now()))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    );
  }

  async revokeLicense(licenseId) {
    return this.#mutate(() => {
      const license = this.data.licenses[licenseId];
      if (!license) throw storeError(404, "license_not_found", "License not found");
      license.status = "revoked";
      license.updatedAt = this.now().toISOString();
      return publicLicense(license, this.plans, this.now());
    });
  }

  async getAccount(rawKey) {
    return this.#read(() => {
      const license = this.#requireActiveLicense(rawKey);
      return publicLicense(license, this.plans, this.now());
    });
  }

  async reserveRequest(rawKey) {
    return this.#mutate(() => {
      const license = this.#requireActiveLicense(rawKey);
      const plan = getPlan(this.plans, license.plan);
      const period = currentPeriod(this.now());
      const used = Number(license.usage[period] || 0);
      if (used >= plan.monthlyRequests) {
        throw storeError(429, "monthly_limit_reached", "Monthly request limit reached");
      }
      license.usage[period] = used + 1;
      license.updatedAt = this.now().toISOString();
      const account = publicLicense(license, this.plans, this.now());
      return {
        licenseId: license.id,
        period,
        usage: account.usage,
        account
      };
    });
  }

  async releaseRequest(licenseId, period) {
    return this.#mutate(() => {
      const license = this.data.licenses[licenseId];
      if (!license) return false;
      license.usage[period] = Math.max(0, Number(license.usage[period] || 0) - 1);
      license.updatedAt = this.now().toISOString();
      return true;
    });
  }

  async applySubscriptionEvent(event = {}) {
    return this.#mutate(() => {
      const eventId = clean(event.eventId, 160);
      if (!eventId) throw storeError(400, "invalid_event", "eventId is required");
      if (this.data.processedEvents[eventId]) {
        return { duplicate: true, license: null, licenseKey: "" };
      }

      const type = clean(event.type, 80);
      const subscription = event.subscription || {};
      const customer = event.customer || {};
      const externalSubscriptionId = clean(subscription.id, 200);
      if (!externalSubscriptionId) {
        throw storeError(400, "invalid_event", "subscription.id is required");
      }

      let license = Object.values(this.data.licenses).find(
        (item) => item.externalSubscriptionId === externalSubscriptionId
      );
      let licenseKey = "";

      if (type === "subscription.activated" && !license) {
        const created = this.#createLicenseRecord({
          email: customer.email,
          plan: subscription.plan,
          seats: subscription.seats,
          status: subscription.status || "active",
          expiresAt: subscription.expiresAt,
          externalCustomerId: customer.id,
          externalSubscriptionId
        });
        license = this.data.licenses[created.license.id];
        licenseKey = created.licenseKey;
      } else {
        if (!license) throw storeError(404, "license_not_found", "Subscription license not found");
        if (type === "subscription.canceled") {
          license.status = "canceled";
        } else if (["subscription.activated", "subscription.updated"].includes(type)) {
          const plan = getPlan(this.plans, subscription.plan || license.plan);
          license.plan = plan.id;
          license.seats = validateSeats(subscription.seats || license.seats, plan);
          license.status = normalizeStatus(subscription.status || license.status);
          license.expiresAt = normalizeOptionalDate(subscription.expiresAt);
        } else {
          throw storeError(400, "invalid_event", `Unsupported event type: ${type || "missing"}`);
        }
        license.updatedAt = this.now().toISOString();
      }

      this.data.processedEvents[eventId] = this.now().toISOString();
      trimProcessedEvents(this.data.processedEvents, 1000);
      return {
        duplicate: false,
        license: publicLicense(license, this.plans, this.now()),
        licenseKey
      };
    });
  }

  #createLicenseRecord(input) {
    const plan = getPlan(this.plans, input.plan || "trial");
    const licenseKey = `cc_live_${randomBytes(24).toString("base64url")}`;
    const nowIso = this.now().toISOString();
    const license = {
      id: `lic_${randomUUID().replace(/-/g, "")}`,
      keyHash: this.#hashKey(licenseKey),
      keyPrefix: licenseKey.slice(0, 15),
      email: clean(input.email, 320).toLowerCase(),
      plan: plan.id,
      status: normalizeStatus(input.status || (plan.id === "trial" ? "trialing" : "active")),
      seats: validateSeats(input.seats || 1, plan),
      externalCustomerId: clean(input.externalCustomerId, 200),
      externalSubscriptionId: clean(input.externalSubscriptionId, 200),
      expiresAt: normalizeOptionalDate(input.expiresAt),
      usage: {},
      createdAt: nowIso,
      updatedAt: nowIso
    };
    this.data.licenses[license.id] = license;
    return {
      license: publicLicense(license, this.plans, this.now()),
      licenseKey
    };
  }

  #requireActiveLicense(rawKey) {
    const keyHash = this.#hashKey(rawKey);
    const license = Object.values(this.data.licenses).find((item) => item.keyHash === keyHash);
    if (!license) throw storeError(401, "invalid_license", "License key is invalid");
    if (!ACTIVE_STATUSES.has(license.status)) {
      throw storeError(403, "inactive_license", `License is ${license.status}`);
    }
    if (license.expiresAt && Date.parse(license.expiresAt) <= this.now().getTime()) {
      throw storeError(403, "expired_license", "License has expired");
    }
    return license;
  }

  #hashKey(rawKey) {
    const key = String(rawKey || "").trim();
    if (!key) throw storeError(401, "missing_license", "License key is required");
    return createHmac("sha256", this.hashSecret).update(key).digest("hex");
  }

  async #read(operation) {
    await this.initialize();
    return this.#runExclusive(operation);
  }

  async #mutate(operation) {
    await this.initialize();
    return this.#runExclusive(async () => {
      const result = operation();
      await this.#persist();
      return result;
    });
  }

  async #persist() {
    const tempPath = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tempPath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    await rename(tempPath, this.filePath);
  }

  #runExclusive(operation) {
    const run = this.queue.then(operation, operation);
    this.queue = run.catch(() => undefined);
    return run;
  }
}

function normalizeData(input) {
  return {
    version: 1,
    licenses: input?.licenses && typeof input.licenses === "object" ? input.licenses : {},
    processedEvents:
      input?.processedEvents && typeof input.processedEvents === "object"
        ? input.processedEvents
        : {}
  };
}

function publicLicense(license, plans, now) {
  const plan = getPlan(plans, license.plan);
  const period = currentPeriod(now);
  const used = Number(license.usage?.[period] || 0);
  return {
    id: license.id,
    keyPrefix: license.keyPrefix,
    email: license.email,
    plan: license.plan,
    planName: plan.name,
    status: license.status,
    seats: license.seats,
    maxSeats: plan.maxSeats,
    expiresAt: license.expiresAt,
    externalCustomerId: license.externalCustomerId,
    externalSubscriptionId: license.externalSubscriptionId,
    createdAt: license.createdAt,
    updatedAt: license.updatedAt,
    usage: {
      period,
      used,
      limit: plan.monthlyRequests,
      remaining: Math.max(0, plan.monthlyRequests - used)
    }
  };
}

function currentPeriod(now) {
  return now.toISOString().slice(0, 7);
}

function validateSeats(value, plan) {
  const seats = Number.parseInt(value || 1, 10);
  if (!Number.isFinite(seats) || seats < 1 || seats > plan.maxSeats) {
    throw storeError(400, "invalid_seats", `${plan.name} supports 1-${plan.maxSeats} seat(s)`);
  }
  return seats;
}

function normalizeStatus(value) {
  const status = clean(value, 40).toLowerCase();
  if (!LICENSE_STATUSES.has(status)) {
    throw storeError(400, "invalid_status", `Unknown license status: ${status || "missing"}`);
  }
  return status;
}

function normalizeOptionalDate(value) {
  if (!value) return "";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) throw storeError(400, "invalid_date", "expiresAt is invalid");
  return new Date(timestamp).toISOString();
}

function trimProcessedEvents(events, limit) {
  const entries = Object.entries(events);
  if (entries.length <= limit) return;
  entries
    .sort((a, b) => a[1].localeCompare(b[1]))
    .slice(0, entries.length - limit)
    .forEach(([key]) => delete events[key]);
}

function clean(value, maxLength) {
  return String(value || "").trim().slice(0, maxLength);
}

function storeError(statusCode, code, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

module.exports = {
  LicenseStore,
  currentPeriod
};
