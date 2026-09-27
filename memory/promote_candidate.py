"""Review and promote generated candidate memories into memory_items."""

from __future__ import annotations

import argparse
import asyncio
import os
from dataclasses import dataclass
from pathlib import Path

import asyncpg

from memory.kinds import DEFAULT_MEMORY_KIND, validate_memory_kind
from memory.manager import MemoryManager, initialize_schema
from memory.text_embeddings import TextEmbedder


@dataclass(frozen=True)
class CandidateMemory:
    path: Path
    title: str
    content: str


def parse_candidate_file(path: Path) -> CandidateMemory:
    if not path.exists() or not path.is_file():
        raise ValueError(f"Candidate file not found: {path}")
    text = path.read_text(encoding="utf-8").strip()
    if not text:
        raise ValueError(f"Candidate file is empty: {path}")

    lines = text.splitlines()
    title = path.stem.removesuffix(".candidate")
    body_start = 0
    for idx, line in enumerate(lines):
        if line.startswith("# "):
            title = line[2:].strip() or title
            body_start = idx + 1
            break
    content = "\n".join(lines[body_start:]).strip() or text
    return CandidateMemory(path=path, title=title, content=content)


def _confirm(candidate: CandidateMemory, kind: str, project_id: str | None) -> bool:
    print(f"Candidate: {candidate.path}")
    print(f"Title: {candidate.title}")
    print(f"Kind: {kind}")
    print(f"Project: {project_id or 'global/system'}")
    print()
    print(candidate.content)
    print()
    answer = input("Promote this candidate to memory_items? [y/N] ").strip().lower()
    return answer in {"y", "yes"}


async def promote_candidate(args: argparse.Namespace) -> int:
    kind = validate_memory_kind(args.kind)
    candidate = parse_candidate_file(args.file)
    if args.dry_run:
        print(f"would promote {candidate.path} kind={kind} title={candidate.title}")
        return 0
    if not args.yes and not _confirm(candidate, kind, args.project_id):
        print("aborted")
        return 1

    db_password = args.db_password or os.getenv("POSTGRES_PASSWORD")
    if not db_password:
        raise RuntimeError("POSTGRES_PASSWORD env or --db-password is required")

    pool = await asyncpg.create_pool(
        host=args.db_host,
        port=args.db_port,
        user=args.db_user,
        password=db_password,
        database=args.db_name,
    )
    try:
        async with pool.acquire() as conn:
            await initialize_schema(conn)
            embedder = TextEmbedder(model_name=args.model, device=args.device)
            embedding = embedder.embed_query(candidate.content)
            memory_id = await MemoryManager().add_memory(
                conn,
                content=candidate.content,
                embedding=embedding,
                project_id=args.project_id,
                created_by=args.created_by,
                kind=kind,
                categories=args.category,
            )
    finally:
        await pool.close()
    print(f"promoted memory_id={memory_id} kind={kind}")
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Promote reviewed candidate Markdown to memory_items.")
    parser.add_argument("-f", "--file", type=Path, required=True)
    parser.add_argument("-k", "--kind", default=DEFAULT_MEMORY_KIND)
    parser.add_argument("-p", "--project-id", default=None)
    parser.add_argument("-y", "--yes", action="store_true", help="Skip interactive confirmation")
    parser.add_argument("-n", "--dry-run", action="store_true")
    parser.add_argument("-c", "--category", action="append", default=None)
    parser.add_argument("--created-by", default="memory-review")
    parser.add_argument("--model", default="BAAI/bge-base-en-v1.5")
    parser.add_argument("--device", default=None)
    parser.add_argument("--db-host", default="localhost")
    parser.add_argument("--db-port", type=int, default=5432)
    parser.add_argument("--db-name", default="knowledge_manager")
    parser.add_argument("--db-user", default="km_user")
    parser.add_argument("--db-password", default=None)
    return parser.parse_args()


def main() -> None:
    raise SystemExit(asyncio.run(promote_candidate(parse_args())))


if __name__ == "__main__":
    main()
