import React from 'react'
import { render } from 'ink'
import { REPL } from './screens/REPL.js'

const workingDir = process.argv[2] ?? process.cwd()

const { waitUntilExit } = render(
  React.createElement(REPL, { workingDir })
)

await waitUntilExit()
