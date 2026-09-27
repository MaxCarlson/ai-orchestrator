from pathlib import Path

import pytest

from memory.ingest_notes import discover_note_files, selected_note_files
from memory.promote_candidate import parse_candidate_file


def test_discover_note_files_returns_markdown_in_stable_order(tmp_path: Path):
    notes = tmp_path / "notes"
    notes.mkdir()
    (notes / "b.md").write_text("b", encoding="utf-8")
    (notes / "a.txt").write_text("a", encoding="utf-8")
    (notes / "nested").mkdir()
    (notes / "nested" / "a.md").write_text("a", encoding="utf-8")

    assert discover_note_files(notes) == [notes / "b.md", notes / "nested" / "a.md"]


def test_selected_note_files_requires_file_or_dir(tmp_path: Path):
    with pytest.raises(ValueError, match="Either --dir or --file"):
        selected_note_files(None, None)

    note = tmp_path / "note.md"
    note.write_text("content", encoding="utf-8")
    assert selected_note_files(None, note) == [note]


def test_parse_candidate_file_uses_heading_as_title(tmp_path: Path):
    candidate_path = tmp_path / "session.candidate.md"
    candidate_path.write_text(
        "# Session Summary\n\nImplemented retrieval improvements.",
        encoding="utf-8",
    )

    candidate = parse_candidate_file(candidate_path)

    assert candidate.title == "Session Summary"
    assert candidate.content == "Implemented retrieval improvements."
