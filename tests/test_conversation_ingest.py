from memory.conversation_ingest import (
    normalize_conversation_content,
    normalize_conversation_json,
    normalize_conversation_ndjson,
    normalize_conversation_text,
)


def test_normalize_plain_text_conversation():
    payload = normalize_conversation_text("User: hello\nAssistant: hi", title="Chat")
    assert payload.title == "Chat"
    assert "Conversation: Chat" in payload.content
    assert "User: hello" in payload.content


def test_normalize_json_conversation_messages():
    payload = normalize_conversation_json(
        '{"title":"Debug Chat","messages":[{"role":"user","content":"why?"},{"role":"assistant","content":"because"}]}'
    )
    assert payload.title == "Debug Chat"
    assert "[USER]" in payload.content
    assert "[ASSISTANT]" in payload.content


def test_normalize_ndjson_conversation():
    payload = normalize_conversation_ndjson(
        '\n'.join([
            '{"role":"user","content":"first","title":"NDJSON Chat"}',
            '{"role":"assistant","content":"second"}',
        ])
    )
    assert payload.title == "NDJSON Chat"
    assert "first" in payload.content
    assert "second" in payload.content


def test_normalize_conversation_content_auto_detects_json():
    payload = normalize_conversation_content('[{"role":"user","content":"hello"}]')
    assert "[USER]" in payload.content
