# Contributing to Linkgress ORM

Thank you for your interest in contributing to Linkgress ORM! This document provides guidelines and instructions for contributing.

## Code of Conduct

By participating in this project, you agree to maintain a respectful and inclusive environment for all contributors.

## How to Contribute

### Reporting Bugs

Before creating a bug report, please check the [existing issues](https://github.com/brunolau/linkgress-orm/issues) to avoid duplicates.

When creating a bug report, include:

- **Clear title and description**
- **Steps to reproduce** the behavior
- **Expected behavior**
- **Actual behavior**
- **Code samples** or test cases
- **Environment details** (Node.js version, TypeScript version, PostgreSQL version, database client used)
- **Error messages** and stack traces

### Suggesting Enhancements

Enhancement suggestions are welcome! Please create an issue with:

- **Clear title and description**
- **Use case** - explain why this enhancement would be useful
- **Proposed solution** - if you have ideas on implementation
- **Alternatives considered**

### Pull Requests

1. **Fork the repository** and create your branch from `main`
2. **Make your changes:**
   - Follow the existing code style
   - Add tests for new functionality
   - Update documentation as needed
3. **Test your changes:**
   ```bash
   npm run test
   npm run type-check
   npm run build
   ```
4. **Commit your changes** with a clear commit message
5. **Push to your fork** and submit a pull request

#### Pull Request Guidelines

- **One feature per PR** - keep changes focused
- **Write tests** - maintain or improve code coverage
- **Update docs** - document new features in the appropriate files
- **Follow TypeScript best practices** - maintain type safety
- **Add examples** - if introducing new API features

## Development Setup

### Prerequisites

- Node.js 16 or higher
- [Bun](https://bun.sh) 1.3 or higher (runs the test suite)
- PostgreSQL 18 (for running tests against a real database; `npm run test:memory` needs none)
- TypeScript 5.0 or higher

### Getting Started

1. **Clone your fork:**
   ```bash
   git clone https://github.com/YOUR_USERNAME/linkgress-orm.git
   cd linkgress-orm
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Set up test database:**
   Create a `.env` file in the root directory:
   ```env
   DB_HOST=localhost
   DB_PORT=5432
   DB_NAME=linkgress_test
   DB_USER=postgres
   DB_PASSWORD=postgres
   ```

4. **Run tests:**
   ```bash
   npm test              # against PostgreSQL
   npm run test:memory   # against the in-memory database
   npm run test:parity   # both, compared
   ```

5. **Build the project:**
   ```bash
   npm run build
   ```

### Project Structure

```
linkgress-orm/
├── src/                  # Source code
│   ├── entity/          # DbContext, entities, configuration
│   ├── query/           # Query builders and executors
│   ├── schema/          # Schema management
│   ├── client/          # Database client implementations
│   └── index.ts         # Public API exports
├── tests/               # Test files
│   ├── queries/        # Query tests
│   ├── schema/         # Schema tests
│   └── utils/          # Test utilities
├── docs/                # Documentation
│   └── guides/         # User guides
└── examples/            # Example code
```

## Code Style

- Use **TypeScript** for all code
- Follow the existing code formatting (we use standard TypeScript conventions)
- Use **meaningful variable and function names**
- Add **JSDoc comments** for public APIs
- Keep functions **focused and small**
- Prefer **composition over inheritance**

### Type Safety

- Maintain **full type safety** - no `any` types without good reason
- Use **generic types** appropriately
- Leverage **type inference** where possible
- Add **type guards** when needed

## Testing

### Writing Tests

- Use **bun:test** for testing (`import { describe, test, expect } from 'bun:test'`); see `tests/README.md`
- Run the suite against PostgreSQL (`npm test`), in memory (`npm run test:memory`), and check both agree (`npm run test:parity`)
- Place tests in the `tests/` directory mirroring the `src/` structure
- Name test files with `.test.ts` extension
- Write **descriptive test names**
- Include both **positive and negative test cases**
- Test **edge cases**

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage

# Run specific test file
npm test -- path/to/test.test.ts

# Run tests matching a pattern
npm test -- -t "pattern"

# Run the suite without a PostgreSQL server: on the built-in in-memory database...
npm run test:memory

# ...or on PGlite (PostgreSQL in WASM, in-process); files that construct PgClient / PostgresClient
# themselves still need the server
npm run test:pglite
```

## Documentation

### Updating Documentation

When adding features or making changes:

1. **Update relevant docs** in the `docs/` directory
2. **Add examples** to demonstrate new functionality
3. **Update README.md** if adding major features
4. **Keep docs concise** and easy to follow
5. **Use code samples** liberally

### Documentation Style

- Use **clear, simple language**
- Provide **working code examples**
- Include **type information** in examples
- Add **cross-references** to related docs
- Use **markdown formatting** consistently

## Commit Messages

Write clear, concise commit messages:

- Use the present tense ("Add feature" not "Added feature")
- Use the imperative mood ("Move cursor to..." not "Moves cursor to...")
- Limit the first line to 72 characters
- Reference issues and pull requests when relevant

### Examples

Good commit messages:
```
Add support for composite foreign keys
Fix memory leak in QueryExecutor
Update schema configuration docs with sequences
```

Bad commit messages:
```
Fixed stuff
Updated
Changes
```

## Release Process

Releases are handled by maintainers. The process:

1. Update version in `package.json`
2. Update `CHANGELOG.md` (if present)
3. Create a git tag
4. Publish to npm
5. Create GitHub release

## Questions?

- **Open an issue** for questions about development
- **Start a discussion** for general questions or ideas
- **Check existing docs** in the `docs/` directory

## License

By contributing to Linkgress ORM, you agree that your contributions will be licensed under the MIT License.

## Recognition

Contributors will be recognized in release notes and the project README (if we add a contributors section).

Thank you for contributing to Linkgress ORM! 🎉
