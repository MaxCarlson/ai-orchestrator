"""
Symbol-aware code chunking for repository indexing.

Currently focuses on Python AST extraction with safe fallbacks for
unsupported files. This keeps indexing deterministic and lightweight.
"""

from __future__ import annotations

import ast
import hashlib
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional


PYTHON_EXTENSIONS = {".py"}
TEXT_EXTENSIONS = {".md", ".txt", ".rst", ".toml", ".yml", ".yaml"}


@dataclass
class CodeChunk:
    file_path: str
    symbol_name: str
    chunk_type: str
    start_line: int
    end_line: int
    content: str
    content_hash: str
    language: str


@dataclass
class ChunkStats:
    file_path: str
    file_type: str
    ast_status: Optional[str]
    chunk_count: int


def _hash_content(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8", errors="ignore")).hexdigest()


def _slice_lines(lines: List[str], start_line: int, end_line: int) -> str:
    start_idx = max(start_line - 1, 0)
    end_idx = min(end_line, len(lines))
    return "\n".join(lines[start_idx:end_idx])


def _chunk_python(content: str, file_path: Path) -> tuple[List[CodeChunk], Optional[str]]:
    chunks: List[CodeChunk] = []
    lines = content.splitlines()
    try:
        tree = ast.parse(content)
    except SyntaxError:
        return [], "failure"

    for node in tree.body:
        if isinstance(node, ast.FunctionDef):
            name = node.name
            start = getattr(node, "lineno", 1)
            end = getattr(node, "end_lineno", start)
            snippet = _slice_lines(lines, start, end)
            chunks.append(
                CodeChunk(
                    file_path=str(file_path),
                    symbol_name=name,
                    chunk_type="function",
                    start_line=start,
                    end_line=end,
                    content=snippet,
                    content_hash=_hash_content(snippet),
                    language="python",
                )
            )
        elif isinstance(node, ast.ClassDef):
            name = node.name
            start = getattr(node, "lineno", 1)
            end = getattr(node, "end_lineno", start)
            snippet = _slice_lines(lines, start, end)
            chunks.append(
                CodeChunk(
                    file_path=str(file_path),
                    symbol_name=name,
                    chunk_type="class",
                    start_line=start,
                    end_line=end,
                    content=snippet,
                    content_hash=_hash_content(snippet),
                    language="python",
                )
            )

    if chunks:
        return chunks, "success"

    # Fallback for small or module-only files.
    if content.strip():
        snippet = content
        chunks.append(
            CodeChunk(
                file_path=str(file_path),
                symbol_name="<module>",
                chunk_type="module",
                start_line=1,
                end_line=len(lines) or 1,
                content=snippet,
                content_hash=_hash_content(snippet),
                language="python",
            )
        )
    return chunks, "success"


def _chunk_text(content: str, file_path: Path, max_chars: int = 2000) -> List[CodeChunk]:
    chunks: List[CodeChunk] = []
    if not content.strip():
        return chunks
    start = 0
    idx = 0
    while start < len(content):
        end = min(start + max_chars, len(content))
        snippet = content[start:end]
        idx += 1
        chunks.append(
            CodeChunk(
                file_path=str(file_path),
                symbol_name=f"<doc-{idx}>",
                chunk_type="doc",
                start_line=1,
                end_line=1,
                content=snippet,
                content_hash=_hash_content(snippet),
                language="text",
            )
        )
        start = end
    return chunks


def chunk_file(path: Path, include_text: bool = True) -> List[CodeChunk]:
    """Chunk a file into symbol-level CodeChunks when possible."""
    if not path.is_file():
        return []

    try:
        content = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return []

    suffix = path.suffix.lower()
    if suffix in PYTHON_EXTENSIONS:
        chunks, _ = _chunk_python(content, path)
        return chunks
    if suffix in TEXT_EXTENSIONS and include_text:
        return _chunk_text(content, path)
    return []


def chunk_file_with_stats(path: Path, include_text: bool = True) -> tuple[List[CodeChunk], ChunkStats]:
    """Chunk a file and return basic parsing stats."""
    if not path.is_file():
        return [], ChunkStats(str(path), "unsupported", None, 0)

    try:
        content = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return [], ChunkStats(str(path), "unsupported", None, 0)

    suffix = path.suffix.lower()
    if suffix in PYTHON_EXTENSIONS:
        chunks, ast_status = _chunk_python(content, path)
        return chunks, ChunkStats(str(path), "python", ast_status, len(chunks))
    if suffix in TEXT_EXTENSIONS:
        if not include_text:
            return [], ChunkStats(str(path), "text", None, 0)
        chunks = _chunk_text(content, path)
        return chunks, ChunkStats(str(path), "text", None, len(chunks))
    return [], ChunkStats(str(path), "unsupported", None, 0)
