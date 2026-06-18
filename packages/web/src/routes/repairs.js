// src/routes/repairs.js
// CI repair proposal API.
//
// GET    /api/repairs               — list proposals (with filters)
// GET    /api/repairs/:id           — get proposal detail
// GET    /api/repairs/:id/events    — get event history (append-only proof trail)
// POST   /api/repairs               — create proposal (detected state, idempotent)
// PATCH  /api/repairs/:id/evidence  — attach evidence (all types validated)
// POST   /api/repairs/:id/transition — lifecycle transition (blocks authority states)
//
// Authority-bearing states (approved, applied, verified_after_apply) are
// BLOCKED from the generic transition endpoint.
//
// expected_version is MANDATORY on PATCH evidence and POST transition.
// Actor identity comes from the authenticated principal, never request body.

import { Router } from "express";
import {
  createProposal,
  getProposal,
  listProposals,
  attachEvidence,
  transitionProposal,
  getProposalEvents,
} from "../services/repairProposalService.js";
import { logger } from "../lib/logger.js";

const router = Router();

// ── GET /api/repairs — list proposals ──────────────────────────────────────

router.get("/", async (req, res) => {
  try {
    const { repo, status, created_by, limit, offset } = req.query;
    const result = await listProposals({
      repo,
      status,
      created_by,
      limit: limit ? parseInt(limit, 10) : 50,
      offset: offset ? parseInt(offset, 10) : 0,
    });
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Failed to list repair proposals");
    res.status(500).json({ error: "Failed to list repair proposals" });
  }
});

// ── GET /api/repairs/:id — get proposal detail ─────────────────────────────

router.get("/:id", async (req, res) => {
  try {
    const proposal = await getProposal(parseInt(req.params.id, 10));
    if (!proposal) {
      return res.status(404).json({ error: "Repair proposal not found" });
    }
    res.json(proposal);
  } catch (err) {
    logger.error({ err }, "Failed to get repair proposal");
    res.status(500).json({ error: "Failed to get repair proposal" });
  }
});

// ── GET /api/repairs/:id/events — get event history ────────────────────────

router.get("/:id/events", async (req, res) => {
  try {
    const events = await getProposalEvents(parseInt(req.params.id, 10));
    res.json({ data: events });
  } catch (err) {
    logger.error({ err }, "Failed to get repair proposal events");
    res.status(500).json({ error: "Failed to get proposal events" });
  }
});

// ── POST /api/repairs — create proposal ────────────────────────────────────

router.post("/", async (req, res) => {
  try {
    const { repo, envelope } = req.body;

    if (!repo) return res.status(400).json({ error: "repo is required" });
    if (!envelope) return res.status(400).json({ error: "envelope is required" });

    const actor = req.user?.login || "system";

    const proposal = await createProposal({ repo, envelope, created_by: actor });
    res.status(201).json(proposal);
  } catch (err) {
    if (err.message.includes("Source mismatch")) {
      return res.status(400).json({ error: err.message });
    }
    if (err.message.includes("Invalid envelope") || err.message.includes("required")) {
      return res.status(400).json({ error: err.message });
    }
    if (err.message.includes("Repository not found")) {
      return res.status(404).json({ error: err.message });
    }
    logger.error({ err }, "Failed to create repair proposal");
    res.status(500).json({ error: "Failed to create repair proposal" });
  }
});

// ── PATCH /api/repairs/:id/evidence — attach evidence ──────────────────────
// expected_version is MANDATORY for race-safe compare-and-swap.

router.patch("/:id/evidence", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { expected_version, ...evidence } = req.body;

    // Validate expected_version before passing to service
    const versionNum = Number(expected_version);
    if (!Number.isInteger(versionNum) || versionNum < 1) {
      return res.status(400).json({
        error: "expected_version is required and must be a positive integer"
      });
    }

    const actor = req.user?.login || "system";
    const proposal = await attachEvidence(id, evidence, actor, versionNum);
    res.json(proposal);
  } catch (err) {
    if (err.message.includes("Version mismatch")) {
      return res.status(409).json({ error: err.message });
    }
    if (err.message.includes("terminal state")) {
      return res.status(409).json({ error: err.message });
    }
    if (err.message.includes("exceeds envelope")) {
      return res.status(400).json({ error: err.message });
    }
    if (err.message.startsWith("Invalid")) {
      return res.status(400).json({ error: err.message });
    }
    if (err.message.includes("No evidence")) {
      return res.status(400).json({ error: err.message });
    }
    if (err.message.includes("not found")) {
      return res.status(404).json({ error: err.message });
    }
    logger.error({ err }, "Failed to attach evidence");
    res.status(500).json({ error: "Failed to attach evidence" });
  }
});

// ── POST /api/repairs/:id/transition — lifecycle transition ────────────────
// Blocks: approved, applied, verified_after_apply (authority-bearing states)
// expected_version is MANDATORY for race-safe compare-and-swap.

router.post("/:id/transition", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { status, reason, expected_version } = req.body;

    if (!status) {
      return res.status(400).json({ error: "status is required" });
    }

    // Validate expected_version before passing to service
    const versionNum = Number(expected_version);
    if (!Number.isInteger(versionNum) || versionNum < 1) {
      return res.status(400).json({
        error: "expected_version is required and must be a positive integer"
      });
    }

    const actor = req.user?.login || "system";
    const proposal = await transitionProposal(id, {
      status,
      actor,
      reason,
      expected_version: versionNum,
    });
    res.json(proposal);
  } catch (err) {
    if (err.message.includes("authority-bound endpoint")) {
      return res.status(403).json({ error: err.message });
    }
    if (err.message.includes("Version mismatch") || err.message.includes("terminal state")) {
      return res.status(409).json({ error: err.message });
    }
    if (
      err.message.includes("Invalid transition") ||
      err.message.includes("missing required evidence") ||
      err.message.includes("Cannot verify") ||
      err.message.includes("Cannot mark review_ready")
    ) {
      return res.status(400).json({ error: err.message });
    }
    if (err.message.includes("required") || err.message.includes("Cannot")) {
      return res.status(400).json({ error: err.message });
    }
    if (err.message.includes("not found")) {
      return res.status(404).json({ error: err.message });
    }
    logger.error({ err }, "Failed to transition repair proposal");
    res.status(500).json({ error: "Failed to transition proposal" });
  }
});

export default router;
