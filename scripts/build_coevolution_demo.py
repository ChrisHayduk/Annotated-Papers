"""Build the co-evolution demo data.

Switched from cytochrome c to **trypsin (serine-protease family, Pfam
PF00089)** after discovering cytochrome c is a poor DCA target: too small
and too functionally constrained (heme binding dominates selection), so
even with sequence reweighting we got Meff ≈ 34 effective sequences and
naive MI coupling was indistinguishable from noise.

Trypsin is the classical DCA benchmark (Morcos et al. 2011, Marks et al.
2011). The serine-protease family is enormous (40k+ sequences in UniProt),
phylogenetically diverse, and has a fold that gives clean co-evolutionary
signal when the MSA is built properly.

**Critically**, we use MAFFT to do the actual MSA rather than the
single-anchor cut-and-paste alignment I tried first. That initial attempt
produced strong artefactual coupling in variable-loop regions because
simple anchor alignment mis-aligns loops. MAFFT's iterative refinement
gets the loops right.

Reads:
  - scripts/data/trypsin_stream.fasta    — raw Pfam PF00089 FASTAs
  - scripts/data/2ptn.pdb                — reference structure

Writes:
  - scripts/data/trypsin_aligned.fasta   — MAFFT-aligned MSA (intermediate)
  - public/co-evolution/trypsin.json     — widget payload

How to regenerate the inputs (they are gitignored because of size):

  # 1. reference structure (~176 KB) — this one IS committed; skip unless missing
  curl -o scripts/data/2ptn.pdb https://files.rcsb.org/download/2PTN.pdb

  # 2. raw trypsin homologs (~13 MB, ~93k sequences) from UniProt's stream
  #    endpoint, filtered to Pfam PF00089:
  curl -o scripts/data/trypsin_stream.fasta \\
    'https://rest.uniprot.org/uniprotkb/stream?query=xref:pfam-PF00089&format=fasta'

  # 3. MAFFT must be installed (brew install mafft). The pipeline calls it
  #    directly; trypsin_aligned.fasta is produced as an intermediate on
  #    first run and cached on subsequent runs.

  # 4. run the pipeline:
  python scripts/build_coevolution_demo.py

Only public/co-evolution/trypsin.json ships to the browser; the fastas are
pure build-time inputs.
"""

import json
import math
import re
import shutil
import subprocess
import tempfile
from pathlib import Path

import numpy as np

HERE = Path(__file__).parent
FASTA_FILE = HERE / "data" / "trypsin_stream.fasta"
PDB_PATH = HERE / "data" / "2ptn.pdb"
ALIGNED_PATH = HERE / "data" / "trypsin_aligned.fasta"
OUTPUT_PATH = HERE.parent / "public" / "co-evolution" / "trypsin.json"

# The reference is bovine β-trypsin, chain A of 2PTN. After MAFFT
# alignment we extract only the columns where the reference has a residue,
# so our final MSA has exactly len(reference) columns, each mapping to one
# residue of the crystal structure.
REFERENCE_CHAIN = "A"
REFERENCE_ID = "REF_2PTN_A"
GAP = "-"

# Cheap pre-filter before MAFFT: skip sequences of grossly wrong length
# and sequences that lack the GDSGG catalytic-Ser motif. GDSGG presence
# is required so MAFFT doesn't waste effort on non-homologs.
LEN_MIN, LEN_MAX = 180, 320
REQUIRE_MOTIF = "GDSGG"

# How many sequences to send to MAFFT. More is better for DCA but slower;
# ~1500-2000 is enough for clean signal on trypsin.
MAX_SEQS_TO_ALIGN = 2000

MAFFT_BIN = shutil.which("mafft") or "/opt/homebrew/bin/mafft"


def parse_multi_fasta(path: Path):
    """Yield (header, seq) tuples from a multi-record FASTA."""
    header = None
    chunks: list[str] = []
    with open(path) as fh:
        for line in fh:
            line = line.rstrip()
            if not line:
                continue
            if line.startswith(">"):
                if header is not None:
                    seq = re.sub(r"[^A-Z-]", "", "".join(chunks).upper())
                    yield header, seq
                header = line[1:]
                chunks = []
            else:
                chunks.append(line)
        if header is not None:
            seq = re.sub(r"[^A-Z-]", "", "".join(chunks).upper())
            yield header, seq


AA3_TO_AA1 = {
    "ALA": "A", "ARG": "R", "ASN": "N", "ASP": "D", "CYS": "C",
    "GLU": "E", "GLN": "Q", "GLY": "G", "HIS": "H", "ILE": "I",
    "LEU": "L", "LYS": "K", "MET": "M", "PHE": "F", "PRO": "P",
    "SER": "S", "THR": "T", "TRP": "W", "TYR": "Y", "VAL": "V",
}


def parse_pdb_chain(path: Path, chain: str) -> tuple[str, list[tuple[int, tuple[float, float, float]]]]:
    """Return (sequence, [(pdb_resnum, ca_coord), ...]) for the chain, in
    sequential residue order. Residues missing a Cα are skipped."""
    residues: dict[int, tuple[str, tuple[float, float, float]]] = {}
    with open(path) as fh:
        for line in fh:
            if not line.startswith("ATOM"):
                continue
            if line[21] != chain:
                continue
            atom = line[12:16].strip()
            if atom != "CA":
                continue
            try:
                resnum = int(line[22:26])
                resname = line[17:20]
                x = float(line[30:38])
                y = float(line[38:46])
                z = float(line[46:54])
            except ValueError:
                continue
            # Keep first occurrence (skip alternate conformers)
            if resnum not in residues:
                residues[resnum] = (AA3_TO_AA1.get(resname, "X"), (x, y, z))
    sorted_nums = sorted(residues.keys())
    seq = "".join(residues[n][0] for n in sorted_nums)
    ca_list = [(n, residues[n][1]) for n in sorted_nums]
    return seq, ca_list


print(f"Parsing {PDB_PATH.name}...")
ref_seq, ca_list = parse_pdb_chain(PDB_PATH, REFERENCE_CHAIN)
REFERENCE_LEN = len(ref_seq)
print(f"  chain {REFERENCE_CHAIN}: {REFERENCE_LEN} Cα atoms")
print(f"  sequence: {ref_seq[:60]}...")
if REQUIRE_MOTIF not in ref_seq:
    raise RuntimeError(
        f"Expected motif {REQUIRE_MOTIF!r} not found in reference sequence"
    )


def uniprot_id(header: str) -> str:
    m = re.match(r"sp\|([^|]+)\||tr\|([^|]+)\|", header)
    if m:
        return m.group(1) or m.group(2)
    return "???"


def extract_species_name(header: str) -> str:
    m = re.search(r"OS=([^=]+?)\s+OX=", header)
    if not m:
        return "?"
    name = m.group(1).strip()
    parts = name.split()
    return " ".join(parts[:2]) if len(parts) >= 2 else name


# ---------- Pre-filter the raw FASTA stream ----------
print(f"\nPre-filtering {FASTA_FILE.name} (length + motif)...")
candidates: list[dict] = []
scanned = 0
skipped = 0
seen_accessions: set[str] = set()
for header, raw in parse_multi_fasta(FASTA_FILE):
    scanned += 1
    if not (LEN_MIN <= len(raw) <= LEN_MAX):
        skipped += 1
        continue
    if REQUIRE_MOTIF not in raw:
        skipped += 1
        continue
    acc = uniprot_id(header)
    if acc in seen_accessions:
        continue
    seen_accessions.add(acc)
    species = extract_species_name(header)
    candidates.append({
        "accession": acc,
        "species": species,
        "common": species,
        "raw": raw,
    })
print(f"  scanned {scanned}, passed pre-filter {len(candidates)}")

# Put familiar species first (for nicer MSA display), then random-sample
# the rest so we don't drown in homologous sequences from one genus.
priority_species = {
    "Bos taurus", "Homo sapiens", "Rattus norvegicus", "Mus musculus",
    "Sus scrofa", "Gallus gallus", "Drosophila melanogaster",
    "Streptomyces griseus",
}
candidates.sort(key=lambda r: (r["species"] not in priority_species, r["accession"]))
if len(candidates) > MAX_SEQS_TO_ALIGN:
    print(f"  subsampling to {MAX_SEQS_TO_ALIGN}")
    priority = [r for r in candidates if r["species"] in priority_species]
    rest = [r for r in candidates if r["species"] not in priority_species]
    rng = np.random.default_rng(0)
    keep_n = MAX_SEQS_TO_ALIGN - len(priority)
    selected = rng.choice(len(rest), size=keep_n, replace=False)
    candidates = priority + [rest[int(i)] for i in selected]
print(f"  prepared {len(candidates)} sequences for MAFFT")


# ---------- Run MAFFT ----------
print(f"\nRunning {MAFFT_BIN} (this takes ~30-90 seconds on ~2000 sequences)...")
with tempfile.NamedTemporaryFile("w", suffix=".fasta", delete=False) as tf:
    # Prepend the reference sequence so we can pull out reference-residue
    # columns after alignment. Use a distinct identifier.
    tf.write(f">{REFERENCE_ID}\n{ref_seq}\n")
    for r in candidates:
        tf.write(f">{r['accession']}|{r['species']}\n{r['raw']}\n")
    input_path = tf.name

result = subprocess.run(
    [MAFFT_BIN, "--auto", "--thread", "-1", input_path],
    capture_output=True,
    text=True,
    check=False,
)
if result.returncode != 0:
    raise RuntimeError(f"MAFFT failed: {result.stderr[-500:]}")

# Parse aligned output and write it to disk for debugging
aligned_lines = result.stdout.splitlines()
with open(ALIGNED_PATH, "w") as fh:
    fh.write(result.stdout)
print(f"  MAFFT done; wrote {ALIGNED_PATH} ({len(result.stdout) // 1024} KB)")

# Parse aligned FASTA
aligned_records: dict[str, str] = {}
cur_id = None
cur_chunks: list[str] = []
for line in aligned_lines:
    line = line.rstrip()
    if line.startswith(">"):
        if cur_id is not None:
            aligned_records[cur_id] = "".join(cur_chunks).upper()
        cur_id = line[1:].split()[0]  # take first token, drop our appended species
        cur_chunks = []
    elif line:
        cur_chunks.append(line)
if cur_id is not None:
    aligned_records[cur_id] = "".join(cur_chunks).upper()

if REFERENCE_ID not in aligned_records:
    raise RuntimeError("Reference sequence missing from MAFFT output")
ref_aligned = aligned_records[REFERENCE_ID]
print(f"  MAFFT alignment width: {len(ref_aligned)} columns")

# Identify the MAFFT columns that contain a residue in the reference row;
# those are the columns we keep. The final alignment has exactly
# REFERENCE_LEN columns, each mapping 1:1 to a residue of the crystal
# structure.
ref_residue_cols = [k for k, c in enumerate(ref_aligned) if c != GAP]
assert len(ref_residue_cols) == REFERENCE_LEN, (
    f"reference has {len(ref_residue_cols)} non-gap cols in MAFFT output, "
    f"expected {REFERENCE_LEN}"
)

# Build the final MSA — one row per MAFFT-aligned sequence, keeping only
# the reference-residue columns.
acc_to_candidate = {r["accession"]: r for r in candidates}
records: list[dict] = []
for mafft_id, aligned in aligned_records.items():
    if mafft_id == REFERENCE_ID:
        continue
    # mafft_id has format "ACC|Species ..." — recover accession
    acc = mafft_id.split("|")[0]
    cand = acc_to_candidate.get(acc)
    if cand is None:
        continue
    row_chars = [aligned[k] for k in ref_residue_cols]
    # Replace MAFFT's lowercase "unaligned" region markers with gaps and
    # canonicalise unknowns.
    row = "".join(c if c in "ACDEFGHIKLMNPQRSTVWY-" else GAP for c in row_chars)
    # Skip rows that are almost entirely gap (alignment failed for them)
    non_gap_frac = sum(1 for c in row if c != GAP) / REFERENCE_LEN
    if non_gap_frac < 0.5:
        continue
    records.append({
        "accession": cand["accession"],
        "species": cand["species"],
        "common": cand["common"],
        "aligned": row,
    })

# Put bovine/human/rat at the top for readability
records.sort(key=lambda r: (r["species"] not in priority_species, r["accession"]))
print(f"  kept {len(records)} rows after mapping to reference columns")

n_seqs = len(records)
n_cols = REFERENCE_LEN


# ---------- Encode + reweight ----------
print("\nEncoding and reweighting...")
ALPHABET = list("ACDEFGHIKLMNPQRSTVWY") + [GAP]
symbol_to_idx = {sym: i for i, sym in enumerate(ALPHABET)}
aligned_arr = np.array(
    [[symbol_to_idx.get(c, 20) for c in r["aligned"]] for r in records],
    dtype=np.int8,
)
assert aligned_arr.shape == (n_seqs, n_cols)

SIM_THRESHOLD = 0.8
print(f"  computing sequence weights at ≥{SIM_THRESHOLD:.0%} identity (vectorised)...")
non_gap = (aligned_arr != 20).astype(np.int32)
neighbour_counts = np.zeros(n_seqs, dtype=np.int32)
CHUNK = 200
for start in range(0, n_seqs, CHUNK):
    end = min(start + CHUNK, n_seqs)
    chunk_aligned = aligned_arr[start:end]
    chunk_nongap = non_gap[start:end]
    eq = (chunk_aligned[:, None, :] == aligned_arr[None, :, :])
    both_non_gap = (chunk_nongap[:, None, :] & non_gap[None, :, :]).astype(bool)
    matches = (eq & both_non_gap).sum(axis=2)
    positions = both_non_gap.sum(axis=2)
    with np.errstate(divide="ignore", invalid="ignore"):
        identity = np.where(positions >= 30, matches / np.maximum(positions, 1), 0)
    is_neighbour = identity >= SIM_THRESHOLD
    neighbour_counts[start:end] = is_neighbour.sum(axis=1)
weights = 1.0 / np.maximum(neighbour_counts, 1)
eff_seqs = float(weights.sum())
print(f"  effective #sequences Meff = {eff_seqs:.1f} (from raw N = {n_seqs})")


# ---------- Weighted MI with APC correction ----------
print("\nComputing weighted MI + APC correction...")


def entropy(counts: np.ndarray) -> float:
    total = counts.sum()
    if total == 0:
        return 0.0
    p = counts[counts > 0] / total
    return -float(np.sum(p * np.log2(p)))


def weighted_mi_pair(col_i: np.ndarray, col_j: np.ndarray, w: np.ndarray) -> float:
    n_sym = len(ALPHABET)
    joint = np.zeros((n_sym, n_sym), dtype=np.float64)
    np.add.at(joint, (col_i, col_j), w)
    w_sum = w.sum()
    # Laplace pseudocount scaled to Meff
    alpha = 0.5 / max(w_sum, 1.0)
    joint += alpha
    p_ij = joint / joint.sum()
    p_i = p_ij.sum(axis=1)
    p_j = p_ij.sum(axis=0)
    # Use natural log then convert for bits
    with np.errstate(divide="ignore", invalid="ignore"):
        log_ratio = np.log2(p_ij) - (np.log2(p_i)[:, None] + np.log2(p_j)[None, :])
    mi = float((p_ij * np.where(np.isfinite(log_ratio), log_ratio, 0)).sum())
    return mi


mi = np.zeros((n_cols, n_cols))
progress_every = max(n_cols // 10, 1)
for i in range(n_cols):
    if i % progress_every == 0:
        print(f"  col {i}/{n_cols}")
    col_i = aligned_arr[:, i]
    for j in range(i + 1, n_cols):
        col_j = aligned_arr[:, j]
        val = weighted_mi_pair(col_i, col_j, weights)
        mi[i, j] = val
        mi[j, i] = val

# APC correction
def apc(m: np.ndarray) -> np.ndarray:
    n = m.shape[0]
    off = m.copy()
    np.fill_diagonal(off, 0)
    rm = off.sum(axis=1) / (n - 1)
    cm = off.sum(axis=0) / (n - 1)
    tm = off.sum() / (n * (n - 1))
    if tm == 0:
        return off
    return m - np.outer(rm, cm) / tm


coupling = apc(mi)
coupling = np.clip(coupling, 0, None)
if coupling.max() > 0:
    coupling = coupling / coupling.max()
np.fill_diagonal(coupling, 0)
print(f"  coupling max = {coupling.max():.3f}")


# ---------- Distance matrix from the PDB ----------
print("\nComputing Cα-Cα distance matrix...")
dist = np.full((n_cols, n_cols), np.nan)
for i, (_, ci) in enumerate(ca_list):
    if i >= n_cols:
        break
    for j, (_, cj) in enumerate(ca_list):
        if j >= n_cols:
            break
        dx = ci[0] - cj[0]
        dy = ci[1] - cj[1]
        dz = ci[2] - cj[2]
        dist[i, j] = math.sqrt(dx * dx + dy * dy + dz * dz)
print(f"  distance range: {np.nanmin(dist):.2f} .. {np.nanmax(dist):.2f} Å")


# ---------- Top-N predictions ----------
MIN_SEP = 5
CONTACT_THRESHOLD = 8.0

pairs_coup = []
pairs_dist = []
for i in range(n_cols):
    for j in range(i + MIN_SEP, n_cols):
        pairs_coup.append((i + 1, j + 1, float(coupling[i, j])))
        if not math.isnan(dist[i, j]):
            pairs_dist.append((i + 1, j + 1, float(dist[i, j])))
pairs_coup.sort(key=lambda t: -t[2])
pairs_dist.sort(key=lambda t: t[2])

TOP_N = REFERENCE_LEN
top_coup_N = pairs_coup[:TOP_N]
true_contact_set = {(i, j) for (i, j, d) in pairs_dist if d <= CONTACT_THRESHOLD}
tp = sum(1 for (i, j, _) in top_coup_N if (i, j) in true_contact_set)
precision = tp / max(len(top_coup_N), 1)
print(f"\nTop-{TOP_N} precision vs. {CONTACT_THRESHOLD} Å contacts: {tp}/{len(top_coup_N)} = {precision:.1%}")

# Top-10 diagnostic
print("\nTop-10 coupling pairs:")
for k, (i, j, c) in enumerate(pairs_coup[:10]):
    d_val = dist[i - 1, j - 1]
    d_str = f"{d_val:.2f} Å" if not math.isnan(d_val) else "n/a"
    hit = "✓" if (i, j) in true_contact_set else "✗"
    print(f"  #{k+1}: pos {i:3d}-{j:3d}  coupling={c:.3f}  dist={d_str} {hit}")


# ---------- Assemble JSON ----------
print("\nWriting JSON...")
OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)

def to_json_dist(arr):
    out = []
    for row in arr:
        out.append([None if math.isnan(v) else round(float(v), 2) for v in row])
    return out

def to_json_coup(arr):
    return [[round(float(v), 4) for v in row] for row in arr]

with open(PDB_PATH) as fh:
    pdb_text = fh.read()

payload = {
    "protein": "Trypsin",
    "reference": {
        "accession": "P00760",
        "name": "bovine β-trypsin",
        "pdb_id": "2PTN",
    },
    "length": REFERENCE_LEN,
    "sequences": [
        {
            "accession": r["accession"],
            "species": r["species"],
            "common": r["common"],
            "aligned": r["aligned"],
        }
        for r in records
    ],
    "coupling": to_json_coup(coupling),
    "distance": to_json_dist(dist),
    "pdb": pdb_text,
    "contact_threshold_A": CONTACT_THRESHOLD,
    "min_separation": MIN_SEP,
    "top_coupling_pairs": [[i, j, round(c, 4)] for (i, j, c) in top_coup_N],
    "top_contact_pairs": [[i, j, round(d, 2)] for (i, j, d) in pairs_dist[:TOP_N]],
    "top_n": TOP_N,
    "top_coupling_precision": round(precision, 3),
    "meff": round(eff_seqs, 1),
    "anchor_motif": REQUIRE_MOTIF,
    # Column index (1..N) → PDB residue number of the reference chain.
    # Lets the 3D panel select residues correctly, and lets the UI display
    # standard literature PDB numbering (e.g. "Cys136–Cys201 disulfide"
    # rather than "col 116–181").
    "column_pdb_residues": [int(n) for n, _ in ca_list],
}

with open(OUTPUT_PATH, "w") as fh:
    json.dump(payload, fh, separators=(",", ":"))

print(f"\n  wrote {OUTPUT_PATH} ({OUTPUT_PATH.stat().st_size // 1024} KB)")
print(f"  protein: {payload['protein']}  length: {payload['length']}")
print(f"  sequences kept: {len(payload['sequences'])}  Meff: {payload['meff']}")
print(f"  top-L precision: {payload['top_coupling_precision']}")
