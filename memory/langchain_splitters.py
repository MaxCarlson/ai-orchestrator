"""
Document splitting utilities using LangChain for the text RAG pipeline.

Provides routing logic that selects the appropriate LangChain text
splitter based on document type, then enriches chunk metadata with
chunk_index, header_context (for markdown), and type fields needed by
the text_chunks database table.
"""

from __future__ import annotations

import hashlib
import logging
from pathlib import Path

from langchain_core.documents import Document
from langchain_text_splitters import MarkdownHeaderTextSplitter, RecursiveCharacterTextSplitter


logger = logging.getLogger(__name__)

# Default splitting parameters
DEFAULT_CHUNK_SIZE = 600
DEFAULT_CHUNK_OVERLAP = 80

# Markdown headers to split on (coarser first, finer last)
_MARKDOWN_HEADERS = [
    ("#", "h1"),
    ("##", "h2"),
    ("###", "h3"),
]


def _get_text_splitter(
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    chunk_overlap: int = DEFAULT_CHUNK_OVERLAP,
) -> RecursiveCharacterTextSplitter:
    """Return a RecursiveCharacterTextSplitter for plain text and PDF.

    Args:
        chunk_size: Maximum characters per chunk.
        chunk_overlap: Character overlap between consecutive chunks.

    Returns:
        Configured RecursiveCharacterTextSplitter instance.
    """
    return RecursiveCharacterTextSplitter(
        chunk_size=chunk_size,
        chunk_overlap=chunk_overlap,
        separators=["\n\n", "\n", ". ", " ", ""],
    )


def _split_markdown(
    doc: Document,
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    chunk_overlap: int = DEFAULT_CHUNK_OVERLAP,
) -> list[Document]:
    """Split a markdown document by headers then recursively by size.

    First applies MarkdownHeaderTextSplitter to break at header
    boundaries, then applies RecursiveCharacterTextSplitter to any
    sections that still exceed chunk_size.

    Args:
        doc: A LangChain Document with markdown content.
        chunk_size: Maximum characters per final chunk.
        chunk_overlap: Character overlap for the recursive splitter.

    Returns:
        List of Documents with header_context metadata populated.
    """
    header_splitter = MarkdownHeaderTextSplitter(
        headers_to_split_on=_MARKDOWN_HEADERS,
        strip_headers=False,
    )
    header_chunks = header_splitter.split_text(doc.page_content)

    # Build breadcrumb context from header metadata
    text_splitter = _get_text_splitter(chunk_size, chunk_overlap)
    final_chunks: list[Document] = []
    for hchunk in header_chunks:
        # Assemble header breadcrumb
        breadcrumb_parts = [
            hchunk.metadata.get("h1", ""),
            hchunk.metadata.get("h2", ""),
            hchunk.metadata.get("h3", ""),
        ]
        breadcrumb = " > ".join(p for p in breadcrumb_parts if p)

        if len(hchunk.page_content) <= chunk_size:
            hchunk.metadata["header_context"] = breadcrumb
            hchunk.metadata["source"] = doc.metadata.get("source", "")
            hchunk.metadata["source_type"] = doc.metadata.get("source_type", "file")
            final_chunks.append(hchunk)
        else:
            sub_chunks = text_splitter.split_text(hchunk.page_content)
            for sub in sub_chunks:
                final_chunks.append(
                    Document(
                        page_content=sub,
                        metadata={
                            "source": doc.metadata.get("source", ""),
                            "source_type": doc.metadata.get("source_type", "file"),
                            "header_context": breadcrumb,
                        },
                    )
                )
    return final_chunks


def split_documents(
    docs: list[Document],
    chunk_size: int = DEFAULT_CHUNK_SIZE,
    chunk_overlap: int = DEFAULT_CHUNK_OVERLAP,
) -> list[Document]:
    """Split and enrich a list of Documents for the text RAG pipeline.

    Routes each document to the appropriate splitter based on its
    source extension or source_type metadata. After splitting, enriches
    each chunk with: chunk_type, chunk_index (per-file), filename,
    file_path, header_context, and content_hash.

    Excludes code files (they are handled by the AST code pipeline).

    Args:
        docs: Input documents from a loader.
        chunk_size: Maximum characters per chunk.
        chunk_overlap: Character overlap between chunks.

    Returns:
        Enriched list of chunk Documents ready for embedding.
    """
    text_splitter = _get_text_splitter(chunk_size, chunk_overlap)
    chunks: list[Document] = []

    # Track per-file chunk index for stable ordering
    file_chunk_counts: dict[str, int] = {}

    for doc in docs:
        source = doc.metadata.get("source", "")
        source_type = doc.metadata.get("source_type", "file")
        ext = Path(source).suffix.lstrip(".").lower()

        # Route to appropriate splitter
        is_markdown = ext in {"md", "markdown"} or source_type == "markdown"
        if is_markdown:
            doc_chunks = _split_markdown(doc, chunk_size, chunk_overlap)
            chunk_type = "markdown_section"
        elif source_type == "pdf":
            doc_chunks = text_splitter.split_documents([doc])
            chunk_type = "pdf_page"
        elif source_type == "api_direct":
            doc_chunks = text_splitter.split_documents([doc])
            chunk_type = "text"
        else:
            doc_chunks = text_splitter.split_documents([doc])
            chunk_type = "text"

        # Assign chunk index and enrich metadata
        if source not in file_chunk_counts:
            file_chunk_counts[source] = 0

        for chunk in doc_chunks:
            idx = file_chunk_counts[source]
            file_chunk_counts[source] += 1

            content = chunk.page_content
            content_hash = hashlib.sha256(content.encode("utf-8")).hexdigest()
            filename = Path(source).name

            chunk.metadata.update(
                {
                    "source": source,
                    "source_type": source_type,
                    "chunk_type": chunk_type,
                    "chunk_index": idx,
                    "file_path": source,
                    "filename": filename,
                    "header_context": chunk.metadata.get("header_context", ""),
                    "content_hash": content_hash,
                }
            )
            chunks.append(chunk)

    logger.info(
        "Split %d documents into %d chunks (chunk_size=%d, overlap=%d)",
        len(docs),
        len(chunks),
        chunk_size,
        chunk_overlap,
    )
    return chunks
