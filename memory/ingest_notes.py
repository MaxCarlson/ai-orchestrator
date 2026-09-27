"""CLI for ingesting human-authored memory notes into text_chunks."""

from __future__ import annotations

import argparse
import asyncio
import os
from pathlib import Path

import asyncpg

from memory.kinds import DEFAULT_MEMORY_KIND, validate_memory_kind
from memory.manager import initialize_schema
from memory.source_ingestion import ingest_local_file


def discover_note_files(directory: Path) -> list[Path]:
    """Return Markdown note files under ``directory`` in stable order."""
    if not directory.exists() or not directory.is_dir():
        raise ValueError(f"Directory not found: {directory}")
    return sorted(path for path in directory.rglob("*.md") if path.is_file())


def selected_note_files(directory: Path | None, file_path: Path | None) -> list[Path]:
    if file_path:
        if not file_path.exists() or not file_path.is_file():
            raise ValueError(f"File not found: {file_path}")
        return [file_path]
    if directory:
        return discover_note_files(directory)
    raise ValueError("Either --dir or --file is required")


def _source_label(path: Path, root: Path | None) -> str:
    if root:
        try:
            return str(path.relative_to(root).with_suffix(""))
        except ValueError:
            pass
    return path.stem


async def ingest_notes(args: argparse.Namespace) -> int:
    kind = validate_memory_kind(args.kind)
    root = args.dir.resolve() if args.dir else None
    files = selected_note_files(root, args.file.resolve() if args.file else None)
    if args.dry_run:
        for path in files:
            print(f"would ingest {path} kind={kind} label={_source_label(path, root)}")
        print(f"{len(files)} note file(s) matched")
        return 0

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
        for path in files:
            result = await ingest_local_file(
                pool,
                project_id=args.project_id,
                path=path,
                source_label=_source_label(path, root),
                ingest_method="notes_cli",
                replace_existing=args.replace,
                dedupe_by_hash=args.dedupe,
            )
            print(f"{path}: {result['status']} chunks={result.get('chunk_count', 0)} kind={kind}")
    finally:
        await pool.close()
    return 0


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Ingest memory/notes Markdown into text_chunks.")
    parser.add_argument("-p", "--project-id", required=True)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("-d", "--dir", type=Path)
    group.add_argument("-f", "--file", type=Path)
    parser.add_argument("-k", "--kind", default=DEFAULT_MEMORY_KIND)
    parser.add_argument("-n", "--dry-run", action="store_true")
    parser.add_argument("--replace", action="store_true")
    parser.add_argument("--dedupe", action="store_true")
    parser.add_argument("--db-host", default="localhost")
    parser.add_argument("--db-port", type=int, default=5432)
    parser.add_argument("--db-name", default="knowledge_manager")
    parser.add_argument("--db-user", default="km_user")
    parser.add_argument("--db-password", default=None)
    return parser.parse_args()


def main() -> None:
    raise SystemExit(asyncio.run(ingest_notes(parse_args())))


if __name__ == "__main__":
    main()
