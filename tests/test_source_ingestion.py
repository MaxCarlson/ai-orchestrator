import pytest

from memory.source_ingestion import detect_source_type, is_global_scope, sanitize_filename


@pytest.mark.parametrize(
    ("filename", "conversation", "expected"),
    [
        ("note.txt", False, "plain_text"),
        ("notes.md", False, "markdown"),
        ("paper.pdf", False, "pdf"),
        ("chat.json", True, "conversation_export"),
        ("chat.ndjson", False, "conversation_export"),
    ],
)
def test_detect_source_type(filename, conversation, expected):
    assert detect_source_type(filename, conversation=conversation) == expected


def test_detect_source_type_rejects_unsupported():
    with pytest.raises(ValueError):
        detect_source_type("archive.zip")


def test_sanitize_filename_blocks_path_traversal():
    result = sanitize_filename("../../bad file?.txt")
    assert "/" not in result
    assert ".." not in result
    assert result.endswith(".txt")


def test_is_global_scope_matches_reserved_uuid():
    assert is_global_scope("00000000-0000-0000-0000-000000000000") is True
    assert is_global_scope("11111111-1111-1111-1111-111111111111") is False
