from pathlib import Path

from memory.code_chunking import chunk_file_with_stats


def test_chunk_typescript_extracts_top_level_symbols(tmp_path: Path):
    source = tmp_path / "QueryEngine.ts"
    source.write_text(
        """
export interface QueryConfig {
  model: string
}

export class QueryEngine {
  submit(input: string) {
    return input
  }
}

export async function ensureLmStudio() {
  return true
}

export const embeddingsCommand = {
  name: 'embeddings'
}
""".strip(),
        encoding="utf-8",
    )

    chunks, stats = chunk_file_with_stats(source, include_text=False)
    symbols = {chunk.symbol_name: chunk for chunk in chunks}

    assert stats.file_type == "typescript"
    assert {"QueryConfig", "QueryEngine", "ensureLmStudio", "embeddingsCommand"} <= set(symbols)
    assert symbols["QueryEngine"].chunk_type == "class"
    assert symbols["QueryEngine"].language == "typescript"
    assert symbols["QueryEngine"].qualified_name.endswith(".QueryEngine")


def test_chunk_shell_extracts_functions(tmp_path: Path):
    source = tmp_path / "local_worker_loop.sh"
    source.write_text(
        """
#!/usr/bin/env bash

poll_queue() {
  echo queued
}

function run_task {
  echo assigned
}
""".strip(),
        encoding="utf-8",
    )

    chunks, stats = chunk_file_with_stats(source, include_text=False)
    symbols = {chunk.symbol_name: chunk for chunk in chunks}

    assert stats.file_type == "shell"
    assert {"poll_queue", "run_task"} <= set(symbols)
    assert symbols["poll_queue"].chunk_type == "function"
    assert symbols["poll_queue"].language == "shell"


def test_chunk_extensionless_python_shebang(tmp_path: Path):
    source = tmp_path / "orch"
    source.write_text(
        """
#!/usr/bin/env python3

def cmd_project_register(args):
    return args
""".strip(),
        encoding="utf-8",
    )

    chunks, stats = chunk_file_with_stats(source, include_text=False)

    assert stats.file_type == "python"
    assert chunks[0].symbol_name == "cmd_project_register"
    assert chunks[0].language == "python"
