"""Build the AlphaFold2 demo trajectory for §14's StructureViewer.

Runs the minAlphaFold2 single-PDB overfit loop and captures intermediate
predictions at a logarithmically-spaced set of steps. Each checkpoint is
written as a Kabsch-aligned PDB so the viewer can overlay them on the
ground truth without doing any alignment itself.

Usage (from annotated-papers repo root):
    python scripts/build_af2_demo.py \\
        --pdb /tmp/1crn.pdb \\
        --out public/af2-demo/alphafold2 \\
        --steps 800 \\
        --model-profile tiny

Output files:
    public/af2-demo/alphafold2/
        ground_truth.pdb
        step_0001.pdb
        step_0005.pdb
        ...
        step_0800.pdb
        trajectory.json   ({ sequence, checkpoints: [...] })
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import torch

# Wire the vendored minAlphaFold submodule into sys.path. Everything below
# assumes this is called from the annotated-papers repo root.
REPO_ROOT = Path(__file__).resolve().parents[1]
VENDOR_ROOT = REPO_ROOT / "vendor" / "min-AlphaFold"
sys.path.insert(0, str(VENDOR_ROOT))
sys.path.insert(0, str(VENDOR_ROOT / "scripts"))

from minalphafold.data import collate_batch  # noqa: E402
from minalphafold.losses import AlphaFoldLoss  # noqa: E402
from minalphafold.model import AlphaFold2  # noqa: E402
from minalphafold.pdbio import write_atom14_pdb, write_model_output_pdb  # noqa: E402
from minalphafold.trainer import (  # noqa: E402
    TrainingConfig,
    build_optimizer,
    load_model_config,
    model_inputs_from_batch,
    move_to_device,
    set_optimizer_learning_rate,
    set_seed,
    zero_dropout_model_config,
)

# These live in the overfit script — reach into the vendor submodule for them.
from overfit_single_pdb import (  # noqa: E402
    apply_kabsch_alignment_to_outputs,
    build_minimal_example,
    loss_inputs_from_batch,
    parse_pdb,
    structure_metrics,
)


def log_spaced_checkpoints(total_steps: int, n: int = 9) -> list[int]:
    """Return ``n`` roughly log-spaced step indices between 1 and total_steps."""
    import math

    out = {1, total_steps}
    for i in range(1, n - 1):
        # Geometric interpolation between 1 and total_steps.
        s = int(round(math.exp(math.log(1) + (math.log(total_steps) - math.log(1)) * i / (n - 1))))
        out.add(max(1, min(total_steps, s)))
    return sorted(out)


def write_checkpoint_pdb(
    out_dir: Path,
    step: int,
    model: AlphaFold2,
    batch: dict,
    training_config: TrainingConfig,
) -> dict:
    """Run a no-grad forward pass, Kabsch-align, save a PDB, return metrics."""
    model.eval()
    with torch.no_grad():
        outputs = model(**model_inputs_from_batch(batch, training_config))
    metrics = structure_metrics(outputs, batch)
    aligned = apply_kabsch_alignment_to_outputs(outputs, batch)
    pdb_path = out_dir / f"step_{step:04d}.pdb"
    write_model_output_pdb(pdb_path, aligned, batch, example_index=0)
    model.train()
    return {
        "step": step,
        "pdb": pdb_path.name,
        **{k: float(v) for k, v in metrics.items()},
    }


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--pdb", type=Path, required=True, help="Ground-truth PDB")
    ap.add_argument("--out", type=Path, required=True, help="Output directory (under public/af2-demo/<slug>/)")
    ap.add_argument("--steps", type=int, default=800)
    ap.add_argument("--learning-rate", type=float, default=1e-3)
    ap.add_argument("--grad-clip-norm", type=float, default=0.1)
    ap.add_argument("--model-profile", type=str, default="tiny")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--n-cycles", type=int, default=1)
    ap.add_argument("--n-checkpoints", type=int, default=9)
    ap.add_argument("--device", type=str, default="cuda" if torch.cuda.is_available() else "cpu")
    args = ap.parse_args()

    set_seed(args.seed)
    device = torch.device(args.device)
    out_dir = args.out
    out_dir.mkdir(parents=True, exist_ok=True)

    checkpoint_steps = log_spaced_checkpoints(args.steps, args.n_checkpoints)
    print(f"[demo] checkpoint steps: {checkpoint_steps}")

    print(f"[demo] parsing {args.pdb}")
    parsed = parse_pdb(args.pdb)
    n_res = parsed["aatype"].shape[0]
    sequence = parsed["sequence"]
    print(f"[demo] sequence ({n_res} residues): {sequence}")

    example = build_minimal_example("demo", parsed, resolution=2.0)
    batch = collate_batch(
        [example],
        crop_size=n_res,
        msa_depth=1,
        extra_msa_depth=0,
        max_templates=0,
        training=True,
        block_delete_training_msa=False,
        masked_msa_probability=0.0,
        random_seed=args.seed,
        num_recycling_samples=1,
        num_ensemble_samples=1,
    )
    batch = move_to_device(batch, device)

    # Write the ground truth PDB once.
    truth_pdb = out_dir / "ground_truth.pdb"
    write_atom14_pdb(
        truth_pdb,
        batch["aatype"][0].detach().cpu(),
        batch["true_atom_positions"][0].detach().cpu(),
        batch["true_atom_mask"][0].detach().cpu(),
        residue_index=batch["residue_index"][0].detach().cpu(),
    )

    model_config = zero_dropout_model_config(load_model_config(args.model_profile))
    model = AlphaFold2(model_config).to(device)
    n_params = sum(p.numel() for p in model.parameters())
    print(f"[demo] model profile: {args.model_profile} ({n_params / 1e6:.2f}M params)")

    training_config = TrainingConfig(
        learning_rate=args.learning_rate,
        grad_clip_norm=args.grad_clip_norm,
        device=str(device),
        seed=args.seed,
        n_cycles=args.n_cycles,
        n_ensemble=1,
    )
    optimizer = build_optimizer(model, training_config)
    loss_fn = AlphaFoldLoss(finetune=False).to(device)

    model.train()
    set_optimizer_learning_rate(optimizer, args.learning_rate)

    # If step 0 is a requested checkpoint (it would be if log_spaced collapses low),
    # capture it before any training — shows the random-init baseline.
    if 0 in checkpoint_steps:
        checkpoint_steps.remove(0)

    trajectory: list[dict] = []
    if 1 in checkpoint_steps:
        # Capture the pre-training / step-1-equivalent state before the first optimizer step.
        ck0 = write_checkpoint_pdb(out_dir, 0, model, batch, training_config)
        ck0["loss"] = None  # no loss yet at step 0
        trajectory.append(ck0)

    loss_log: list[dict] = []
    start = time.time()
    for step in range(1, args.steps + 1):
        optimizer.zero_grad(set_to_none=True)
        outputs = model(**model_inputs_from_batch(batch, training_config))
        per_example_loss = loss_fn(**loss_inputs_from_batch(batch, outputs))
        loss = per_example_loss.mean()
        loss.backward()
        if training_config.grad_clip_norm is not None:
            torch.nn.utils.clip_grad_norm_(model.parameters(), training_config.grad_clip_norm)
        optimizer.step()
        loss_value = float(loss.item())
        loss_log.append({"step": step, "loss": loss_value})

        if step in checkpoint_steps:
            ck = write_checkpoint_pdb(out_dir, step, model, batch, training_config)
            ck["loss"] = loss_value
            trajectory.append(ck)
            elapsed = time.time() - start
            print(
                f"[demo] step {step:4d}/{args.steps}  loss={loss_value:.4f}  "
                f"ca_rmsd={ck['ca_rmsd_after_alignment']:.3f}  "
                f"bb_rmsd={ck['backbone_rmsd_after_alignment']:.3f}  "
                f"aa_rmsd={ck['all_atom_rmsd_after_alignment']:.3f}  ({elapsed:.0f}s)"
            )

    payload = {
        "pdb_id": args.pdb.stem,
        "sequence": sequence,
        "num_residues": n_res,
        "total_steps": args.steps,
        "model_profile": args.model_profile,
        "n_params_millions": round(n_params / 1e6, 2),
        "ground_truth_pdb": "ground_truth.pdb",
        "checkpoints": trajectory,
        "loss_log": loss_log,
    }
    (out_dir / "trajectory.json").write_text(json.dumps(payload, indent=2))
    print(f"[demo] wrote {len(trajectory)} checkpoints + trajectory.json to {out_dir}")


if __name__ == "__main__":
    main()
