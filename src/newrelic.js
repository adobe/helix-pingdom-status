/*
 * Copyright 2019 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/* eslint-disable no-console */

const yargs = require('yargs');
const fs = require('fs');
const path = require('path');
const request = require('request-promise-native');

const frequency = 15;
const status = 'ENABLED';
const slaThreshold = 7;
const locations = ['AWS_AP_NORTHEAST_1',
  'AWS_AP_NORTHEAST_2',
  'AWS_AP_SOUTH_1',
  'AWS_AP_SOUTHEAST_1',
  'AWS_AP_SOUTHEAST_2',
  'AWS_CA_CENTRAL_1',
  'AWS_EU_CENTRAL_1',
  'AWS_EU_WEST_1',
  'AWS_EU_WEST_2',
  'AWS_EU_WEST_3',
  'AWS_SA_EAST_1',
  'AWS_US_EAST_1',
  'AWS_US_EAST_2',
  'AWS_US_WEST_1',
  'AWS_US_WEST_2',
  'LINODE_US_CENTRAL_1',
  'LINODE_US_EAST_1',
  'LINODE_US_WEST_1'];
const monitorType = 'SCRIPT_API';
const channelType = 'EMAIL';

let packageName;

try {
  packageName = JSON.parse(fs.readFileSync('package.json')).name;
} catch (e) {
  packageName = undefined;
}


async function getMonitors(auth, monitorname, monitorid) {
  try {
    let more = true;
    const loadedmonitors = [];
    while (more) {
      // eslint-disable-next-line no-await-in-loop
      const response = await request.get(`https://synthetics.newrelic.com/synthetics/api/v3/monitors?limit=100&offset=${loadedmonitors.length}`, {
        headers: {
          'X-Api-Key': auth,
        },
        json: true,
      });
      if (response.count < 10) {
        more = false;
      }
      loadedmonitors.push(...response.monitors);
    }

    const monitors = loadedmonitors.map(({ id, name }) => ({ id, name }));
    if (monitorid) {
      return monitors.filter((monitor) => monitor.id === monitorid);
    }
    if (monitorname) {
      return monitors.filter((monitor) => monitor.name === monitorname);
    } else {
      return [];
    }
  } catch (e) {
    console.error('Unable to retrieve monitors', e.message);
    return [];
  }
}

async function updateScript(auth, monitor, url) {
  console.log('Updating the script for monitor', monitor.name);

  const scriptText = Buffer.from(fs
    .readFileSync(path.resolve(__dirname, 'synthetics.js'))
    .toString()
    .replace('$$$URL$$$', url))
    .toString('base64');

  await request.put(`https://synthetics.newrelic.com/synthetics/api/v3/monitors/${monitor.id}/script`, {
    json: true,
    headers: {
      'X-Api-Key': auth,
    },
    body: {
      scriptText,
    },
  });
}

async function updateOrCreateMonitor(auth, name, monitorId, url) {
  const [monitor] = await getMonitors(auth, name, monitorId);

  if (monitor) {
    console.log(`Monitor ID: ${monitor.id}`);
    // update
    await updateScript(auth, monitor, url);
  } else {
    // create
    console.log('Creating a new monitor', name);
    try {
      await request.post('https://synthetics.newrelic.com/synthetics/api/v3/monitors', {
        json: true,
        headers: {
          'X-Api-Key': auth,
        },
        body: {
          name,
          type: monitorType,
          frequency,
          locations,
          status,
          slaThreshold,
        },
      });
      await updateOrCreateMonitor({
        auth, name, id: monitorId, url,
      });
    } catch (e) {
      console.error('Monitor creation failed', e.message);
      process.exit(1);
    }
  }
}

async function getNotificationChannels(auth, email) {
  try {
    const response = await request.get('https://api.newrelic.com/v2/alerts_channels.json', {
      headers: {
        'X-Api-Key': auth,
      },
      json: true,
    });
    const loadedchannels = response.channels;

    const channels = loadedchannels.map(({ id, recipients }) => ({ id, recipients }));
    if (email) {
      return channels.filter((channel) => channel.type === channelType
        && channel.recipients === email);
    } else {
      return [];
    }
  } catch (e) {
    console.error('Unable to retrieve channels', e.message);
    return [];
  }
}

async function createNotificationChannel(auth, name, email) {
  let [channel] = getNotificationChannels(auth, email);

  if (channel) {
    console.log(`Reusing existing notification channel ${channel.name} with same recipients`);
  } else {
    console.log('Creating a new notification channel', email);

    channel = await request.post('https://api.newrelic.com/v2/alerts_channels.json', {
      json: true,
      headers: {
        'X-Api-Key': auth,
      },
      body: {
        channel: {
          name,
          type: channelType,
          configuration: {
            recipients: email,
            include_json_attachment: true,
          },
        },
      },
    }).channel;
  }
  return channel.id;
}

// eslint-disable-next-line no-unused-vars
async function updateOrCreateAlertPolicy(auth, name, monitorId, policyId, channelId) {
  // TODO
}

async function updateOrCreate({
  // eslint-disable-next-line camelcase
  auth, name, url, email, monitor_id, policy_id,
}) {
  const monitorId = await updateOrCreateMonitor(auth, name, monitor_id, url);
  const channelId = email ? await createNotificationChannel(auth, name, email) : null;
  await updateOrCreateAlertPolicy(auth, name, monitorId, policy_id, channelId);

  console.log('done.');
}

function baseargs(y) {
  return y
    .positional('url', {
      type: 'string',
      required: true,
      describe: 'the URL to check',
    })
    .option('auth', {
      type: 'string',
      describe: 'your New Relic API Key (alternatively use $NEWRELIC_AUTH env var)',
      required: true,
    })
    .option('name', {
      type: 'string',
      describe: 'the name of the monitor and alert policy (defaults to package name)',
      required: packageName === undefined,
      default: packageName,
    })
    .option('email', {
      type: 'string',
      describe: 'the email address to send alerts to',
      required: false,
    });
}

function run() {
  return yargs
    .scriptName('newrelic')
    .usage('$0 <cmd> url')
    .command('create url', 'Create a new New Relic setup', (y) => baseargs(y), updateOrCreate)
    .command('update url', 'Update an existing New Relic setup', (y) => baseargs(y)
      .option('monitor_id', {
        type: 'string',
        describe: 'The ID of the monitor to update',
      })
      .option('policy_id', {
        type: 'string',
        describe: 'The ID of the alert policy to update',
      }), updateOrCreate)
    .help()
    .strict()
    .demandCommand(1)
    .env('NEWRELIC')
    .argv;
}

run();
