#!/usr/bin/env node

import { Context } from '@panedesk/cordis'
import { pathToFileURL } from 'node:url'
import Loader from '@panedesk/cordis-plugin-loader'

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'

await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@panedesk/cordis-plugin-include',
  config: {
    path: './cordis.yml',
  },
})
