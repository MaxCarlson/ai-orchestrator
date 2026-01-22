# Awesome Copilot Essentials
## A Focused Guide for Python, ML, and Agentic CLI Development

> **Purpose**: This is a distilled reference from [github/awesome-copilot](https://github.com/github/awesome-copilot) optimized for Python developers using Claude Code CLI, OpenAI Codex CLI, and GitHub Copilot CLI. Bloat removed. Core patterns preserved.

---

## Table of Contents

1. [Overview: The Three Primitives](#overview-the-three-primitives)
2. [Quick Start: File Placement](#quick-start-file-placement)
3. [Instructions: Repo-Level Behavior](#instructions-repo-level-behavior)
4. [Skills: Bundled Capabilities](#skills-bundled-capabilities)
5. [Custom Agents: Specialized Personas](#custom-agents-specialized-personas)
6. [Creating Your Own](#creating-your-own)
7. [CLI Compatibility Notes](#cli-compatibility-notes)
8. [Curated Examples](#curated-examples)

---

## Overview: The Three Primitives

| Primitive | Purpose | File Pattern | Scope |
|-----------|---------|--------------|-------|
| **Instructions** | Coding standards, conventions, behaviors | `*.instructions.md` | Auto-applied to matching files |
| **Skills** | Reusable workflows with bundled assets | `SKILL.md` in folder | On-demand, progressive loading |
| **Agents** | Specialized personas with tools | `*.agent.md` | Invoked explicitly |

### How They Differ

```
Instructions = "Always do X when working with .py files"
Skills       = "Here's a complete workflow for doing Y, with templates and scripts"
Agents       = "I am an expert in Z, here's how I work"
```

---

## Quick Start: File Placement

### Standard Repository Structure

```
your-repo/
├── .github/
│   ├── copilot-instructions.md     # Root instructions (always active)
│   ├── instructions/
│   │   ├── python.instructions.md   # Auto-applies to **/*.py
│   │   ├── testing.instructions.md  # Testing conventions
│   │   └── ml-training.instructions.md
│   └── agents/
│       ├── debug.agent.md
│       ├── plan.agent.md
│       └── ml-experiment.agent.md
├── skills/
│   ├── data-pipeline/
│   │   ├── SKILL.md
│   │   ├── scripts/
│   │   └── references/
│   └── model-training/
│       └── SKILL.md
└── AGENTS.md                        # Optional: repo-wide agent definition
```

### Alternative: Claude Code / Codex CLI Conventions

Some CLIs use different conventions:

```
your-repo/
├── CLAUDE.md              # Claude Code CLI instructions
├── AGENTS.md              # Agent definitions
├── .cursorrules           # Cursor-compatible
├── .copilot/
│   └── instructions.md    # Copilot CLI
└── docs/
    └── SKILLS/            # Skill folders
```

---

## Instructions: Repo-Level Behavior

Instructions are **passive context** that shape how the AI behaves when working with specific files or across the entire repo.

### File Format

```yaml
---
description: 'Brief description of these instructions'
applyTo: '**/*.py'  # Glob pattern - when to apply
---

# Your Instructions (Markdown body)

## Section 1
- Bullet points work well
- Be specific and actionable

## Section 2
Code examples help:
```python
# Good pattern
def example(param: str) -> dict:
    """Docstring required."""
    pass
```
```

### Key Fields

| Field | Required | Purpose |
|-------|----------|---------|
| `description` | Yes | Shown in UI, helps discovery |
| `applyTo` | No | Glob pattern for auto-application |
| `name` | No | Display name (defaults to filename) |

### applyTo Patterns

```yaml
applyTo: '**/*.py'           # All Python files
applyTo: 'tests/**/*.py'     # Only test files
applyTo: '**.py, **.pyi'     # Multiple patterns
applyTo: 'src/ml/**'         # Specific directory
applyTo: '**/requirements*.txt, **/pyproject.toml'  # Config files
```

### Placement Options

| Location | Scope | Auto-Applied? |
|----------|-------|---------------|
| `.github/copilot-instructions.md` | Entire repo | Always |
| `.github/instructions/*.instructions.md` | Pattern-matched files | When `applyTo` matches |
| In-file (docstrings, comments) | Single file | Always for that file |

---

### Example: Python Instructions

```yaml
---
description: 'Python coding conventions and best practices'
applyTo: '**/*.py'
---

# Python Coding Conventions

## Type Hints
- All functions must have type hints for parameters and return values
- Use `typing` module for complex types: `List[str]`, `Dict[str, Any]`, `Optional[T]`
- Use `TypedDict` for structured dictionaries

## Docstrings
- Follow Google-style docstrings
- Include Args, Returns, Raises sections for public functions
- Example:
```python
def train_model(config: ModelConfig, data: pd.DataFrame) -> TrainedModel:
    """Train a model with the given configuration.

    Args:
        config: Model hyperparameters and settings.
        data: Training data as a DataFrame.

    Returns:
        Trained model instance ready for inference.

    Raises:
        ValueError: If data is empty or config is invalid.
    """
```

## Error Handling
- Use specific exception types, not bare `except:`
- Always log exceptions with context
- Use `contextlib.suppress()` for expected errors

## Testing
- Test files in `tests/` mirror `src/` structure
- Use pytest fixtures for setup
- Aim for 80%+ coverage on business logic
```

---

### Example: ML Project Instructions

```yaml
---
description: 'Machine learning project conventions for experiment tracking and reproducibility'
applyTo: '**/*.py'
---

# ML Project Standards

## Experiment Tracking
- All experiments MUST be logged (MLflow, W&B, or custom)
- Log: hyperparameters, metrics, model artifacts, data versions
- Use deterministic seeds for reproducibility

## Model Development
- Separate data loading, preprocessing, training, and evaluation
- Use configuration files (YAML/JSON) for hyperparameters, never hardcode
- Version control your data processing pipelines

## Code Organization
```
src/
├── data/           # Data loading and preprocessing
├── models/         # Model architectures
├── training/       # Training loops
├── evaluation/     # Metrics and evaluation
└── utils/          # Shared utilities
```

## Dependencies
- Pin exact versions in requirements.txt for reproducibility
- Use virtual environments or containers
- Document GPU/CUDA requirements
```

---

## Skills: Bundled Capabilities

Skills are **self-contained folders** with instructions and bundled resources (scripts, templates, reference docs). They follow the [Agent Skills specification](https://agentskills.io/specification).

### When to Use Skills vs Instructions

| Use Instructions When... | Use Skills When... |
|--------------------------|-------------------|
| Setting coding standards | Complex multi-step workflows |
| Defining conventions | Bundled scripts or templates needed |
| Simple behavioral rules | Reusable across projects |
| File-specific guidance | Progressive disclosure wanted |

### Skill Structure

```
skill-name/
├── SKILL.md              # Required: Main instructions
├── LICENSE.txt           # Optional: License info
├── scripts/              # Optional: Executable code
│   └── helper.py
├── references/           # Optional: Documentation for AI to read
│   └── api-reference.md
├── templates/            # Optional: Starter code to modify
│   └── starter.py
└── assets/               # Optional: Static files (images, fonts)
    └── diagram.png
```

### SKILL.md Format

```yaml
---
name: my-skill-name
description: 'What it does. Use when <triggers, keywords, scenarios>.'
license: MIT
compatibility: 'Python 3.10+, requires pandas'
allowed-tools: 'editFiles search runInTerminal'
---

# Skill Title

Brief overview of the skill's purpose.

## When to Use This Skill

- User says "create a data pipeline"
- User wants to process CSV files
- User mentions ETL or data transformation

## Prerequisites

- Python 3.10+
- pandas, numpy installed

## Workflow

### Step 1: Analyze Data
1. Examine the input files
2. Identify schema and data types
3. Report findings

### Step 2: Transform
[Detailed instructions...]

## References

- See [references/pandas-patterns.md](references/pandas-patterns.md) for common patterns
```

### Critical: The Description Field

The `description` is the **primary discovery mechanism**. It must include:

1. **WHAT** the skill does
2. **WHEN** to use it (triggers, keywords)
3. **Keywords** users might say

**Good:**
```yaml
description: 'Build data pipelines for ML training. Use when asked to create ETL workflows, process datasets, transform CSV/Parquet files, or prepare training data. Triggers: "data pipeline", "ETL", "preprocessing", "feature engineering".'
```

**Bad:**
```yaml
description: 'Data processing helpers'
```

---

### Example: ML Data Pipeline Skill

```
data-pipeline/
├── SKILL.md
├── scripts/
│   └── validate_schema.py
├── references/
│   └── pandas-patterns.md
└── templates/
    └── pipeline_template.py
```

**SKILL.md:**
```yaml
---
name: data-pipeline
description: 'Create robust data pipelines for ML projects. Use when asked to build ETL workflows, process datasets, create feature engineering pipelines, or prepare training data. Triggers on "data pipeline", "ETL", "preprocessing", "feature engineering", "data loading".'
---

# ML Data Pipeline Builder

Build production-ready data pipelines for machine learning projects.

## When to Use This Skill

- "Create a data pipeline for my training data"
- "Build an ETL workflow"
- "Preprocess this dataset"
- "Create feature engineering pipeline"

## Prerequisites

- Python 3.10+
- pandas, pyarrow, pydantic

## Workflow

### 1. Schema Definition

First, define your data schema using Pydantic:

```python
from pydantic import BaseModel
from typing import Optional

class DataSchema(BaseModel):
    feature_a: float
    feature_b: str
    label: Optional[int] = None
```

### 2. Data Loading

Use the template in [templates/pipeline_template.py](templates/pipeline_template.py):

```python
def load_data(path: str, schema: type[BaseModel]) -> pd.DataFrame:
    """Load and validate data against schema."""
    df = pd.read_parquet(path)
    # Validate each row
    validated = [schema(**row).dict() for row in df.to_dict('records')]
    return pd.DataFrame(validated)
```

### 3. Transformation

See [references/pandas-patterns.md](references/pandas-patterns.md) for common transformations.

### 4. Validation

Run the validation script:
```bash
python scripts/validate_schema.py --input data.parquet --schema schema.json
```

## Output

The pipeline produces:
- Validated, transformed data in Parquet format
- Schema documentation
- Data quality report

## References

- [Pandas patterns](references/pandas-patterns.md)
- [Validation script docs](scripts/README.md)
```

---

## Custom Agents: Specialized Personas

Agents are **specialized AI personas** with defined roles, tools, and behaviors. They're invoked explicitly (e.g., `@agent-name` in VS Code, or by specifying in CLI).

### Agent File Format

```yaml
---
description: 'Brief description for discovery'
name: 'Display Name'
tools: ['tool1', 'tool2', 'toolset/*']
model: GPT-4.1  # Optional: specific model
mcp-servers:    # Optional: MCP server configuration
  server-name:
    type: 'http'
    url: 'https://example.com/mcp'
handoffs:       # Optional: workflow transitions
  - label: 'Next Step'
    agent: 'other-agent'
    prompt: 'Continue with...'
    send: false
---

# Agent Title

You are a [role]. Your task is to [purpose].

## Your Expertise
- Bullet points of capabilities

## Your Approach
- How you work

## Guidelines
- Specific rules

## Response Style
- How to format responses
```

### Tools Reference

**Read-only tools** (for planning, research, review):
```yaml
tools: ['search', 'web/fetch', 'githubRepo', 'usages', 'problems', 'searchResults', 'codebase']
```

**Edit tools** (for implementation):
```yaml
tools: ['edit/editFiles', 'new', 'changes']
```

**Execution tools**:
```yaml
tools: ['runCommands', 'runTests', 'runInTerminal', 'testFailure']
```

**Python-specific**:
```yaml
tools: ['runNotebooks', 'configurePythonEnvironment', 'getPythonEnvironmentInfo', 'installPythonPackage']
```

**MCP wildcard** (all tools from a server):
```yaml
tools: ['mcp-server-name/*']
```

---

### Example: Debug Agent

```yaml
---
description: 'Debug your application to find and fix bugs'
tools: ['edit/editFiles', 'search', 'runInTerminal', 'problems', 'testFailure', 'runTests', 'usages']
---

# Debug Mode

You are in debug mode. Systematically identify, analyze, and resolve bugs.

## Phase 1: Problem Assessment

1. **Gather Context**: Read error messages, stack traces, examine codebase structure
2. **Reproduce the Bug**: Run tests/application to confirm the issue
3. **Document**: Steps to reproduce, expected vs actual behavior

## Phase 2: Investigation

1. **Root Cause Analysis**: Trace execution path, examine variable states
2. **Hypothesis Formation**: Form specific hypotheses about the cause
3. **Use Tools**: Search for usages, check for similar patterns

## Phase 3: Resolution

1. **Implement Fix**: Make targeted, minimal changes
2. **Verify**: Run tests, check for regressions
3. **Document**: Explain what was fixed and why

## Guidelines

- Be systematic - follow phases, don't jump to solutions
- Document findings and attempts
- Make small, testable changes
- Always reproduce before fixing
```

---

### Example: Plan Agent

```yaml
---
description: 'Strategic planning and architecture assistant - think before coding'
name: 'Plan Mode'
tools: ['search/codebase', 'web/fetch', 'githubRepo', 'problems', 'usages']
---

# Plan Mode - Strategic Planning

You are a strategic planning assistant. Think first, code later.

## Core Principles

**Information Gathering**: Understand context, requirements, and codebase before proposing solutions.

**Collaborative Strategy**: Engage in dialogue to clarify objectives and develop the best approach.

## Workflow

### 1. Understand the Goal
- Ask clarifying questions
- Explore relevant files and architecture
- Identify constraints and requirements

### 2. Analyze Before Planning
- Review existing implementations
- Identify dependencies and integration points
- Assess complexity and scope

### 3. Develop Strategy
- Break down into manageable components
- Propose clear implementation steps
- Identify challenges and mitigations
- Consider multiple approaches

### 4. Present the Plan
- Detailed strategy with reasoning
- Specific file locations and patterns
- Suggested implementation order
- Areas needing more research

## Response Style

- Conversational, engage in dialogue
- Thorough analysis
- Explain reasoning
- Present options with trade-offs
```

---

### Example: ML Experiment Agent

```yaml
---
description: 'Design and run machine learning experiments with proper tracking and reproducibility'
name: 'ML Experiment Mode'
tools: ['search', 'edit/editFiles', 'runInTerminal', 'runNotebooks', 'configurePythonEnvironment', 'installPythonPackage', 'problems']
---

# ML Experiment Agent

You are an ML experiment specialist focused on reproducibility, proper tracking, and systematic experimentation.

## Your Expertise

- Experiment design and hypothesis formation
- Hyperparameter optimization strategies
- MLflow/W&B experiment tracking
- Reproducibility best practices
- Statistical analysis of results

## Your Approach

1. **Hypothesis First**: Always start with a clear hypothesis
2. **Baseline Comparison**: Establish baselines before experimenting
3. **One Variable at a Time**: Isolate changes for clear attribution
4. **Track Everything**: Log all hyperparameters, metrics, artifacts

## Workflow

### Starting an Experiment

1. Define hypothesis clearly
2. Check for existing baselines
3. Set up experiment tracking
4. Create configuration file
5. Implement with proper logging

### Running Experiments

```python
# Always use this pattern
import mlflow

with mlflow.start_run(run_name="experiment_description"):
    mlflow.log_params(config)
    # ... training code ...
    mlflow.log_metrics(metrics)
    mlflow.log_artifact(model_path)
```

### Analyzing Results

1. Compare against baseline
2. Check statistical significance
3. Document findings
4. Update hypothesis based on results

## Guidelines

- Never run experiments without tracking
- Always set random seeds
- Use config files, not hardcoded values
- Document negative results too
- Version control your data processing
```

---

### Example: Critical Thinking Agent

```yaml
---
description: 'Challenge assumptions and encourage critical thinking before implementation'
tools: ['codebase', 'search', 'usages', 'web/fetch']
---

# Critical Thinking Mode

You challenge assumptions and encourage deep thinking. You do NOT make edits - you help engineers think through their approach.

## Instructions

- Ask 'Why?' repeatedly until reaching root assumptions
- Do NOT suggest solutions or provide direct answers
- Play devil's advocate to expose potential flaws
- Be firm but friendly
- Ask ONE question at a time (no multi-part questions)
- Have strong opinions, held loosely

## Example Questions

- "What happens if this fails?"
- "Why did you choose X over Y?"
- "What assumptions are you making here?"
- "How would this scale?"
- "What's the worst case scenario?"
```

---

## Creating Your Own

### Instruction Template

```yaml
---
description: '[What these instructions enforce]'
applyTo: '[glob pattern]'
---

# [Title]

## [Category 1]
- Rule 1
- Rule 2

## [Category 2]
- Rule 3

## Examples

```python
# Good
...

# Bad
...
```
```

### Skill Template

```
your-skill/
└── SKILL.md
```

```yaml
---
name: your-skill
description: '[What it does]. Use when [triggers, scenarios, keywords].'
---

# [Skill Title]

[Overview]

## When to Use This Skill
- Trigger 1
- Trigger 2

## Prerequisites
- Dependency 1

## Workflow

### Step 1: [Action]
[Instructions]

### Step 2: [Action]
[Instructions]

## References
- Link to bundled docs
```

### Agent Template

```yaml
---
description: '[Brief role description]'
name: '[Display Name]'
tools: ['tool1', 'tool2']
---

# [Agent Title]

You are [role]. Your task is [purpose].

## Your Expertise
- Capability 1
- Capability 2

## Your Approach
- Method 1
- Method 2

## Guidelines
- Rule 1
- Rule 2

## Response Style
- Format preference
- Detail level
```

---

## CLI Compatibility Notes

### Claude Code CLI

- Reads `CLAUDE.md` or `.claude/instructions.md` in repo root
- Supports MCP servers for extended tool access
- Can use custom agents via prompt files

### OpenAI Codex CLI

- Uses `.codex/instructions.md` or inline system prompts
- Agents defined via session configuration
- No native MCP support (use wrapper)

### GitHub Copilot CLI

- Standard `.github/copilot-instructions.md`
- Full support for agents and skills in VS Code
- MCP servers configurable per-workspace

### Universal Compatibility Tips

1. **Root instructions file**: Always have a `CLAUDE.md` / `copilot-instructions.md` / `AGENTS.md`
2. **Keep agents simple**: Avoid tool dependencies that aren't available
3. **Document requirements**: List which CLI tools support which features
4. **Use file-based context**: Skills with references work everywhere

---

## Curated Examples

### Python/ML Relevant Agents

| Agent | Purpose | Tools Focus |
|-------|---------|-------------|
| `debug.agent.md` | Bug finding and fixing | Test execution, search |
| `plan.agent.md` | Strategic planning | Read-only, research |
| `python-mcp-expert.agent.md` | MCP server development | Python tooling |
| `semantic-kernel-python.agent.md` | SK development | Full stack |
| `critical-thinking.agent.md` | Challenge assumptions | Read-only |
| `mentor.agent.md` | Learning and guidance | Read-only |
| `janitor.agent.md` | Code cleanup | Edit, search |

### Python/ML Relevant Collections

| Collection | Contents | Tags |
|------------|----------|------|
| `python-mcp-development` | MCP server building in Python | python, mcp, fastmcp |
| `openapi-to-application-python-fastapi` | Generate FastAPI from OpenAPI | python, fastapi, api |
| `testing-automation` | Test writing and TDD | testing, pytest |
| `project-planning` | Planning and architecture | planning, tasks |
| `technical-spike` | Research spikes | research, validation |

### Skills Worth Adapting

| Skill | Bundled Assets | Adaptable For |
|-------|----------------|---------------|
| `github-issues` | Issue templates | Any issue/task tracking |
| `make-skill-template` | None | Creating new skills |
| `appinsights-instrumentation` | Scripts, references | Any telemetry setup |

---

## Resources

- **Official Repo**: https://github.com/github/awesome-copilot
- **Agent Skills Spec**: https://agentskills.io/specification
- **MCP Registry**: https://github.com/modelcontextprotocol

---

## Quick Reference Card

```
┌─────────────────────────────────────────────────────────────┐
│                    FILE PLACEMENT                            │
├─────────────────────────────────────────────────────────────┤
│ .github/copilot-instructions.md    → Always active          │
│ .github/instructions/*.md          → Pattern-matched        │
│ .github/agents/*.agent.md          → Explicit invocation    │
│ skills/<name>/SKILL.md             → On-demand loading      │
│ AGENTS.md (root)                   → Repo-wide agent        │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    FRONTMATTER                               │
├─────────────────────────────────────────────────────────────┤
│ Instructions:                                                │
│   description: 'What these do'                              │
│   applyTo: '**/*.py'                                        │
│                                                              │
│ Skills:                                                      │
│   name: skill-name (must match folder)                      │
│   description: 'What + When + Keywords'                     │
│                                                              │
│ Agents:                                                      │
│   description: 'Brief role'                                 │
│   tools: ['tool1', 'tool2']                                 │
│   model: GPT-4.1 (optional)                                 │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│                    TOOLS QUICK REF                           │
├─────────────────────────────────────────────────────────────┤
│ Read:    search, codebase, usages, problems, githubRepo     │
│ Edit:    edit/editFiles, new, changes                       │
│ Execute: runInTerminal, runTests, runNotebooks              │
│ Python:  configurePythonEnvironment, installPythonPackage   │
│ Web:     web/fetch, web/search                              │
│ MCP:     mcp-server-name/*                                  │
└─────────────────────────────────────────────────────────────┘
```

---

*Generated from awesome-copilot commit: main branch, January 2025*
*Filtered for: Python, ML/AI, Claude Code CLI, OpenAI Codex CLI, Copilot CLI*
