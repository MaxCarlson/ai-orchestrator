"""
Symbol-aware code chunking for repository indexing.

Currently focuses on Python AST extraction with safe fallbacks for
unsupported files. This keeps indexing deterministic and lightweight.
"""

from __future__ import annotations

import ast
import hashlib
import re
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional


PYTHON_EXTENSIONS = {".py"}
TYPESCRIPT_EXTENSIONS = {".ts", ".tsx"}
SHELL_EXTENSIONS = {".sh", ".bash", ".zsh"}
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
    module: str = ""
    symbol_kind: str = ""
    qualified_name: str = ""
    parent_symbol: str = ""
    is_test: bool = False


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


def _module_name(path: Path) -> str:
    return path.with_suffix("").as_posix().replace("/", ".")


def _is_test_path(path: Path) -> bool:
    parts = {part.lower() for part in path.parts}
    name = path.name.lower()
    return "tests" in parts or "test" in parts or name.startswith("test_") or name.endswith((".test.ts", ".spec.ts", ".test.tsx", ".spec.tsx"))


def _detect_language(content: str, path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in PYTHON_EXTENSIONS:
        return "python"
    if suffix in TYPESCRIPT_EXTENSIONS:
        return "typescript"
    if suffix in SHELL_EXTENSIONS:
        return "shell"
    first_line = content.splitlines()[0] if content.splitlines() else ""
    if first_line.startswith("#!") and "python" in first_line:
        return "python"
    if first_line.startswith("#!") and any(shell in first_line for shell in ("sh", "bash", "zsh")):
        return "shell"
    if suffix in TEXT_EXTENSIONS:
        return "text"
    return "unsupported"


def _make_chunk(
    *,
    path: Path,
    symbol_name: str,
    chunk_type: str,
    start_line: int,
    end_line: int,
    content: str,
    language: str,
    parent_symbol: str = "",
) -> CodeChunk:
    module = _module_name(path)
    return CodeChunk(
        file_path=str(path),
        symbol_name=symbol_name,
        chunk_type=chunk_type,
        start_line=start_line,
        end_line=end_line,
        content=content,
        content_hash=_hash_content(content),
        language=language,
        module=module,
        symbol_kind=chunk_type,
        qualified_name=f"{module}.{symbol_name}" if symbol_name != "<module>" else module,
        parent_symbol=parent_symbol,
        is_test=_is_test_path(path),
    )


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
                _make_chunk(
                    path=file_path,
                    symbol_name=name,
                    chunk_type="function",
                    start_line=start,
                    end_line=end,
                    content=snippet,
                    language="python",
                )
            )
        elif isinstance(node, ast.ClassDef):
            name = node.name
            start = getattr(node, "lineno", 1)
            end = getattr(node, "end_lineno", start)
            snippet = _slice_lines(lines, start, end)
            chunks.append(
                _make_chunk(
                    path=file_path,
                    symbol_name=name,
                    chunk_type="class",
                    start_line=start,
                    end_line=end,
                    content=snippet,
                    language="python",
                )
            )

    if chunks:
        return chunks, "success"

    # Fallback for small or module-only files.
    if content.strip():
        snippet = content
        chunks.append(
            _make_chunk(
                path=file_path,
                symbol_name="<module>",
                chunk_type="module",
                start_line=1,
                end_line=len(lines) or 1,
                content=snippet,
                language="python",
            )
        )
    return chunks, "success"


TS_DECLARATION_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    ("function", re.compile(r"^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b")),
    ("class", re.compile(r"^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)\b")),
    ("interface", re.compile(r"^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)\b")),
    ("type", re.compile(r"^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\b")),
    ("const", re.compile(r"^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\b")),
]


def _find_statement_end(lines: list[str], start_index: int) -> int:
    brace_balance = 0
    saw_brace = False
    for idx in range(start_index, len(lines)):
        line = lines[idx]
        brace_balance += line.count("{") - line.count("}")
        saw_brace = saw_brace or "{" in line
        if saw_brace and brace_balance <= 0:
            return idx + 1
        if not saw_brace and line.rstrip().endswith(";"):
            return idx + 1
    return len(lines)


def _chunk_typescript(content: str, file_path: Path) -> list[CodeChunk]:
    chunks: list[CodeChunk] = []
    lines = content.splitlines()
    for idx, line in enumerate(lines):
        for chunk_type, pattern in TS_DECLARATION_PATTERNS:
            match = pattern.match(line)
            if not match:
                continue
            name = match.group(1)
            end_line = _find_statement_end(lines, idx)
            snippet = _slice_lines(lines, idx + 1, end_line)
            chunks.append(
                _make_chunk(
                    path=file_path,
                    symbol_name=name,
                    chunk_type=chunk_type,
                    start_line=idx + 1,
                    end_line=end_line,
                    content=snippet,
                    language="typescript",
                )
            )
            break

    if chunks:
        return chunks
    if content.strip():
        chunks.append(
            _make_chunk(
                path=file_path,
                symbol_name="<module>",
                chunk_type="module",
                start_line=1,
                end_line=len(lines) or 1,
                content=content,
                language="typescript",
            )
        )
    return chunks


SHELL_FUNCTION_PATTERNS = [
    re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(\)\s*\{"),
    re.compile(r"^\s*function\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(\))?\s*\{"),
]


def _chunk_shell(content: str, file_path: Path) -> list[CodeChunk]:
    chunks: list[CodeChunk] = []
    lines = content.splitlines()
    for idx, line in enumerate(lines):
        name = None
        for pattern in SHELL_FUNCTION_PATTERNS:
            match = pattern.match(line)
            if match:
                name = match.group(1)
                break
        if not name:
            continue
        end_line = _find_statement_end(lines, idx)
        snippet = _slice_lines(lines, idx + 1, end_line)
        chunks.append(
            _make_chunk(
                path=file_path,
                symbol_name=name,
                chunk_type="function",
                start_line=idx + 1,
                end_line=end_line,
                content=snippet,
                language="shell",
            )
        )

    if chunks:
        return chunks
    if content.strip():
        chunks.append(
            _make_chunk(
                path=file_path,
                symbol_name="<script>",
                chunk_type="script",
                start_line=1,
                end_line=len(lines) or 1,
                content=content,
                language="shell",
            )
        )
    return chunks


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
            _make_chunk(
                path=file_path,
                symbol_name=f"<doc-{idx}>",
                chunk_type="doc",
                start_line=1,
                end_line=1,
                content=snippet,
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

    language = _detect_language(content, path)
    if language == "python":
        chunks, _ = _chunk_python(content, path)
        return chunks
    if language == "typescript":
        return _chunk_typescript(content, path)
    if language == "shell":
        return _chunk_shell(content, path)
    if language == "text" and include_text:
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

    language = _detect_language(content, path)
    if language == "python":
        chunks, ast_status = _chunk_python(content, path)
        return chunks, ChunkStats(str(path), "python", ast_status, len(chunks))
    if language == "typescript":
        chunks = _chunk_typescript(content, path)
        return chunks, ChunkStats(str(path), "typescript", "success" if chunks else None, len(chunks))
    if language == "shell":
        chunks = _chunk_shell(content, path)
        return chunks, ChunkStats(str(path), "shell", "success" if chunks else None, len(chunks))
    if language == "text":
        if not include_text:
            return [], ChunkStats(str(path), "text", None, 0)
        chunks = _chunk_text(content, path)
        return chunks, ChunkStats(str(path), "text", None, len(chunks))
    return [], ChunkStats(str(path), "unsupported", None, 0)
