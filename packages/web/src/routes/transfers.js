// src/routes/transfers.js
// Repository transfer API — migrate data or start fresh when a repo changes org/owner.
//
// POST /api/repos/:owner/:repo/transfer/preview  — preview what would happen
// POST /api/repos/:owner/:repo/transfer           — execute the transfer

import { Router } from "express";
import { transferRepo, getTransferPreview } from "../services/repoTransferService.js";
import { logger } from "../lib/logger.js";

const router = Router();

// ── POST /api/repos/:owner/:repo/transfer/preview ─────────────────────────
router.post("/:owner/:repo/transfer/preview", async (req, res) => {
  try {
    const fullName = req.params.owner + "/" + req.params.repo;
    const preview = await getTransferPreview(fullName);
    res.json(preview);
  } catch (err) {
    logger.error({ err }, "Transfer preview failed");
    res.status(400).json({ error: err.message });
  }
});

// ── POST /api/repos/:owner/:repo/transfer ─────────────────────────────────
router.post("/:owner/:repo/transfer", async (req, res) => {
  try {
    const currentFullName = req.params.owner + "/" + req.params.repo;
    const { new_full_name, migrate } = req.body;

    if (!new_full_name) {
      return res.status(400).json({ error: "new_full_name is required" });
    }
    if (typeof migrate !== "boolean") {
      return res.status(400).json({ error: "migrate must be true or false" });
    }

    const result = await transferRepo({
      currentFullName,
      newFullName: new_full_name,
      migrate,
    });

    const status = result.status === "already_transferred" ? 200 : 200;
    res.json(result);
  } catch (err) {
    logger.error({ err }, "Repo transfer failed");
    res.status(400).json({ error: err.message });
  }
});

export default router;
