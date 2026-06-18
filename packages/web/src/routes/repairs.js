// src/routes/repairs.js
// CI repair proposal API.
//
// READ-ONLY public API. All mutation is handled by trusted service paths:
// - Proposal creation: ciEvidenceCollectorService
// - Evidence attachment: ciEvidenceCollectorService (CI evidence)
//   Future: diagnosis_worker, patch_worker, etc. (other evidence types)
// - Lifecycle transitions: ciEvidenceCollectorService (detected → evidence_collected)
//   Future: dedicated approval/rejection flows for authority-bearing states
//
// Public endpoints:
// GET    /api/repairs               — list proposals (with filters)
// GET    /api/repairs/:id           — get proposal detail
// GET    /api/repairs/:id/events    — get event history (append-only proof trail)
//
// The following routes return 403 until dedicated operator/worker flows exist:
// POST   /api/repairs               — create proposal
// PATCH  /api/repairs/:id/evidence  — attach evidence
// POST   /api/repairs/:id/transition — lifecycle transition

import { Router } from "express";
import {
  getProposal,
  listProposals,
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

// ════════════════════════════════════════════════════════════════════════════
// MUTATION ROUTES — RESTRICTED (403)
// All proposal mutation is handled by trusted service paths with actor-kind
// enforcement. The public API is read-only until dedicated operator flows exist.
// ════════════════════════════════════════════════════════════════════════════

// POST /api/repairs — create proposal (restricted)
router.post("/", (req, res) => {
  res.status(403).json({
    error: "Repair proposals are created by the trusted CI evidence collector service, not by API callers"
  });
});

// PATCH /api/repairs/:id/evidence — attach evidence (restricted)
router.patch("/:id/evidence", (req, res) => {
  res.status(403).json({
    error: "Evidence attachment is handled by trusted worker services with field-level authority. The public API is read-only."
  });
});

// POST /api/repairs/:id/transition — lifecycle transition (restricted)
router.post("/:id/transition", (req, res) => {
  res.status(403).json({
    error: "Lifecycle transitions are handled by trusted worker services. The public API is read-only."
  });
});

export default router;
