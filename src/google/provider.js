const log = require('bole')('kubeform.google')
const meta = require('./metadata')()
const uuid = require('uuid')
const SIZE_REGEX = /^([0-9]+)(MB|GB)$/
const Promise = require('bluebird')

const BASELINE_SERVICES = [
  'servicemanagement.googleapis.com',
  'cloudapis.googleapis.com'
]

const SUPPORTING_SERVICES = [
  'compute.googleapis.com',
  'container.googleapis.com',
  'storage-component.googleapis.com',
  'storage-api.googleapis.com'
]

async function checkCluster (client, options) {
  let pause = 5000
  let done = false
  const request = {
    projectId: options.projectId,
    zone: options.operation.zone,
    operationId: options.operation.name
  }
  do {
    const [result] = await client.getOperation(request)
    log.info(`cluster status is ${result.status}`)
    if (
      result.status === undefined ||
      result.status === 'PROVISIONING' ||
      result.status === 'RECONCILING' ||
      result.status === 'STATUS_UNSPECIFIED' ||
      result.status === 'RUNNING'
    ) {
      await wait(pause)
      pause *= 1.5
      if (pause > 60000) {
        pause = 60000
      }
    } else {
      done = true
    }
  } while (!done)
}

function create (resource, iam, client, storage, events, config, opts) {
  const options = meta.mergeOptions(config, opts)
  meta.validateOptions(options)
  return createProject(resource, options)
    .then(() => enableServices(iam, options, BASELINE_SERVICES))
    .then(() => fixBilling(iam, options))
    .then(() => enableServices(iam, options, SUPPORTING_SERVICES))
    .then(() => createClusterService(iam, options))
    .then(() => getAccountCredentials(iam, options))
    .then(() => setRoles(iam, options))
    .then(() => events.emit('prerequisites-created', {
      provider: 'gce',
      prerequisites: [
        'project-created',
        'service-apis-enabled',
        'billing-associated',
        'service-account-created',
        'account-credentials-acquired',
        'iam-roles-assigned'
      ]
    }))
    .then(() => grantBucketAccess(storage, options))
    .then(() => events.emit('bucket-permissions-set', {
      readAccess: [ options.readableBuckets ],
      writeAccess: [ options.writableBuckets ]
    }))
    .then(() => createCluster(client, options))
    .then(() => events.emit('cluster-initialized', {
      kubernetesCluster: getClusterConfig(options)
    }))
    .then(() => checkCluster(client, options))
    .then(() => options)
}

function createCluster (client, options) {
  const seconds = 60
  log.info(`creating Kubernetes cluster for project ${options.projectId}`)
  const config = getClusterConfig(options)
  return client.createCluster(config)
    .then(
      result => {
        options.operation = result[0]
        return options
      },
      async err => {
        if (err.message.indexOf('wait a few minutes') >= 0) {
          log.warn(`failed to provision cluster due to race conditions in Google API initialization. Trying again in ${seconds} seconds ...`)
          await wait(seconds * 1000)
          return createCluster(client, options)
        } else {
          const msg = `failed to instantiate cluster with ${err.message}`
          log.error(msg)
          throw new Error(msg)
        }
      }
    )
}

async function createProject (resource, options) {
  const name = `npme-${options.name}`
  log.info(`creating project ${name}`)
  options.projectId = options.projectId || name
  const project = await getProject(resource, options)
  if (project) {
    log.info(`project ${name} already exists, skipping creation step`)
    return Promise.resolve({
      project
    })
  }
  return resource.createProject(
    name,
    {
      name: name,
      parent: {
        type: 'organization',
        id: options.organizationId
      }
    }
  ).then(
    ([proj, op, resp]) => {
      return op.promise()
        .then(() => {
          return {project: proj, response: resp}
        })
    }
  ).catch(
    err => {
      const msg = `failed to create project ${options.name} for organization ${options.organizationId} with ${err.message}`
      log.error(msg)
      throw new Error(msg)
    }
  )
}

function createClusterService (iam, options) {
  log.info(`creating service account for project ${options.projectId}`)
  return iam.createServiceAccount(
    options.projectId,
    options.serviceAccount,
    'npme kubernetes service account'
  ).then(
    (body) => {
      if (body.email) {
        options.serviceAccount = body.email
      }
      return body
    },
    err => {
      const msg = `failed to create cluster service ${options.serviceAccount} with ${err.message}`
      log.error(msg)
      throw new Error(msg)
    }
  )
}

function enableServices (iam, options, services) {
  log.info(`enabling services ${services.join(', ')} for project ${options.projectId}`)
  return Promise.mapSeries(services, service => iam.enableService(options.projectId, service))
}

function fixBilling (iam, options) {
  log.info(`associating billing account with project ${options.projectId}`)
  return iam.assignBilling(options.projectId, options.billingAccount)
    .catch(
      err => {
        const msg = `failed to associate billing with account ${options.serviceAccount} with ${err.message}`
        log.error(msg)
        throw new Error(msg)
      }
    )
}

function getAccountCredentials (iam, options) {
  log.info(`acquiring service account credentials for project ${options.projectId}`)
  return iam.createCredentials(
    options.projectId,
    options.serviceAccount
  ).then(
    credentials => {
      options.credentials = credentials
      return credentials
    },
    err => {
      const msg = `failed to get account credentials for ${options.serviceAccount} with ${err.message}`
      log.error(msg)
      throw new Error(msg)
    }
  )
}

function getBucketAccess (bucket, options) {
  log.info(`getting bucket access for project ${options.projectId}`)
  return bucket.iam.getPolicy()
    .then(
      data => {
        return data[0]
      },
      err => {
        const msg = `failed to get roles for ${bucket.name} with ${err.message}`
        log.error(msg)
        throw new Error(msg)
      }
    )
}

function getClusterConfig (options) {
  const manager = options.manager || {}
  manager.network = manager.network || {}
  const config = {
    projectId: options.projectId,
    zone: options.zones[0],
    cluster: {
      name: options.name,
      description: options.description,
      nodePools: [
        getNodeConfig(options)
      ],
      network: options.worker.network ? options.worker.network.vpc : undefined,
      clusterIpv4Cidr: options.worker.network ? options.worker.network.range : undefined,
      initialClusterVersion: options.version,
      locations: options.zones,
      addonsConfig: {
        httpLoadBalancing: {
          disabled: options.flags.loadBalancedHTTP !== true
        },
        horizontalPodAutoscaling: {
          disabled: options.flags.autoScale !== true
        },
        kubernetesDashboard: {
          disabled: options.flags.includeDashboard !== true
        },
        networkPolicyConfig: {
          disabled: options.flags.networkPolicy !== true
        }
      },
      legacyAbac: {
        enabled: options.flags.legacyAuthorization === true
      },
      networkPolicy: {
        enabled: options.flags.networkPolicy,
        provider: 'CALICO'
      },
      managedAuthorizedNetworksConfig: {
        enabled: options.manager.network.authorizedCidr !== undefined,
        cidrBlocks: options.manager.network.authorizedCidr ? options.manager.network.authorizedCidr.map(x => {
          return {
            displayName: x.name,
            cidrBlock: x.block
          }
        }) : []
      },
      maintenancePolicy: {
        window: {
          dailyMaintenanceWindow: {
            startTime: options.worker.maintenanceWindow
          }
        }
      }
    }
  }
  config.cluster.masterAuth = {
    clientCertificateConfig: {
      issueClientCertificate: options.flags.clientCert
    }
  }
  if (options.flags.basicAuth) {
    config.cluster.masterAuth.username = options.user
    config.cluster.masterAuth.password = options.password || uuid.v4()
  }
  if (options.flags.serviceMonitoring === false) {
    config.cluster.monitoringService = 'none'
  }
  if (options.flags.serviceLogging === false) {
    config.cluster.loggingService = 'none'
  }
  return config
}

function getNodeConfig (options) {
  let worker = options.worker
  let persistent = 0
  if (worker.storage.persistent) {
    const [, size, units] = SIZE_REGEX.exec(worker.storage.persistent)
    if (units.toUpperCase() !== 'GB') {
      persistent = size / 1024
    } else {
      persistent = size
    }
  }
  const config = {
    config: {
      machineType: meta.getMachineType(worker),
      serviceAccount: options.serviceAccount,
      diskSizeGb: persistent,
      imageType: 'COS',
      localSsdCount: 0,
      preemptible: worker.reserved !== true,
      workloadMetadataConfig: {
        nodeMetadata: 'SECURE'
      },
      oauthScopes: [
        'https://www.googleapis.com/auth/compute',
        'https://www.googleapis.com/auth/devstorage.read_only'
      ]
    },
    initialNodeCount: options.worker.count,
    name: 'default-pool'
  }
  if (options.flags) {
    config.management = {
      autoRepair: options.flags.autoRepair,
      autoUpgrade: options.flags.autoUpgrade
    }
    if (options.flags.autoScale && options.worker.min && options.worker.max) {
      config.autoscaling = {
        enabled: true,
        maxNodeCount: options.worker.max,
        minNodeCount: options.worker.min
      }
    }
  }
  return config
}

function getProject (resource, options) {
  return resource.getProjects()
    .then(
      results => {
        const projects = results[0]
        let match
        while (projects.length > 0) {
          const project = projects.pop()
          if (project.id === options.projectId) {
            match = project
            break
          }
        }
        return match
      },
      err => {
        log.err(`failed to get a project list to check for project ${options.projectId} existence with ${err.message}`)
        return undefined
      }
    )
}

function setBucketAccess (bucket, options, roles, account, role) {
  log.info(`setting bucket access for project ${options.projectId}`)
  let bindings = roles.bindings
  let added = false
  let i = 0
  const assignment = `serviceAccount:${account}`
  while (i < bindings.length) {
    const binding = bindings[i]
    if (binding.role === role) {
      if (binding.members.indexOf(assignment) < 0) {
        binding.members.push(assignment)
      }
      added = true
    }
    i++
  }
  if (!added) {
    roles.bindings.push({
      role: role,
      members: [ assignment ]
    })
  }
  return bucket.iam.setPolicy(roles)
    .catch(err => {
      const msg = `failed to grant ${account} to ${role} with ${err.message}`
      log.error(msg)
      throw new Error(msg)
    })
}

function grantBucketAccess (storage, options) {
  log.info(`granting bucket access for project ${options.projectId}`)
  const readable = options.readableBuckets || []
  const readPromises = readable.map(bucketName => {
    const bucket = storage.bucket(bucketName)
    return getBucketAccess(bucket, options)
      .then(
        roles => setBucketAccess(
          bucket,
          options,
          roles,
          options.serviceAccount,
          'roles/storage.legacyBucketReader'
        )
      )
  })
  const writeable = options.writeableBuckets || []
  const writePromises = writeable.map(bucketName => {
    const bucket = storage.bucket(bucketName)
    return getBucketAccess(bucket)
      .then(
        roles => setBucketAccess(
          bucket,
          roles,
          options.serviceAccount,
          'role/storage.legacyBucketWriter'
        )
      )
  })

  return Promise.all(
    [].concat(readPromises, writePromises)
  )
}

function setRoles (iam, options) {
  log.info(`setting service account roles ${options.projectId}`)
  return iam.assignRoles(
    options.projectId,
    'serviceAccount',
    options.serviceAccount,
    [
      'roles/logging.privateLogViewer',
      'roles/monitoring.metricWriter',
      'roles/monitoring.viewer',
      'roles/storage.admin',
      'roles/storage.objectAdmin',
      'roles/storage.objectCreator',
      'roles/storage.objectViewer'
    ]
  ).then(
    null,
    err => {
      const msg = `failed to assign roles to cluster service ${options.serviceAccount} with ${err.message}`
      log.error(msg)
      throw new Error(msg)
    }
  )
}

function wait (ms) {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve()
    }, ms)
  })
}

module.exports = function (config, resource, iam, client, storage, events) {
  return {
    create: create.bind(null, resource, iam, client, storage, events, config),
    createCluster: createCluster.bind(null, client),
    createProject: createProject.bind(null, resource),
    createClusterService: createClusterService.bind(null, iam),
    fixBilling: fixBilling.bind(null, iam),
    getAccountCredentials: getAccountCredentials.bind(null, iam),
    getClusterConfig,
    getNodeConfig,
    grantBucketAccess: grantBucketAccess.bind(null, storage),
    setRoles: setRoles.bind(null, iam)
  }
}