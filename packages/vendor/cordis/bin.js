#!/usr/bin/env node

import { Context } from '@agentchat/cordis'
import { pathToFileURL } from 'node:url'
import Loader from '@agentchat/cordis-loader'

const ctx = new Context()
ctx.baseUrl = pathToFileURL(process.cwd()).href + '/'

await ctx.plugin(Loader)
await ctx.loader.create({
  name: '@agentchat/cordis-include',
  config: {
    path: './cordis.yml',
  },
})
