// 'sanbashi' is a word in Japanese that refers to a pier or dock, usually very large in size, such as found in Tokyo's O-daiba region

let Glob = require('glob')
let Path = require('path')
let Inquirer = require('inquirer')
let os = require('os')
const Child = require('child_process')
const debug = require('debug')('plugin-local-build')

const DOCKERFILE_REGEX = /\bDockerfile(.\w*)?$/
let Sanbashi = function () {}

Sanbashi.getDockerfiles = function (rootdir, recursive) {
  let match = recursive ? './**/Dockerfile?(.)*' : 'Dockerfile*'
  let dockerfiles = Glob.sync(match, {
    cwd: rootdir,
    nonull: false,
    nodir: true
  })
  if (recursive) {
    dockerfiles = dockerfiles.filter(df => df.match(/Dockerfile\.[\w]+/))
  } else {
    dockerfiles = dockerfiles.filter(df => df.match(/Dockerfile$/))
  }
  return dockerfiles.map(file => Path.join(rootdir, file))
}

Sanbashi.getJobs = function (resourceRoot, dockerfiles) {
  return dockerfiles
  // convert all Dockerfiles into job Objects
    .map((dockerfile) => {
      let match = dockerfile.match(DOCKERFILE_REGEX)
      if (!match) return
      let proc = (match[1] || '.standard').slice(1)
      return {
        name: proc,
        resource: `${resourceRoot}/${proc}`,
        dockerfile: dockerfile,
        postfix: Path.basename(dockerfile) === 'Dockerfile' ? 0 : 1,
        depth: Path.normalize(dockerfile).split(Path.sep).length
      }
    })
    // prefer closer Dockerfiles, then prefer Dockerfile over Dockerfile.web
    .sort((a, b) => {
      return a.depth - b.depth || a.postfix - b.postfix
    })
    // group all Dockerfiles for the same process type together
    .reduce((jobs, job) => {
      jobs[job.name] = jobs[job.name] || []
      jobs[job.name].push(job)
      return jobs
    }, {})
}

Sanbashi.chooseJobs = async function (jobs) {
  let chosenJobs = []
  for (let processType in jobs) {
    let group = jobs[processType]
    if (group.length > 1) {
      let prompt = {
        type: 'list',
        name: processType,
        choices: group.map(j => j.dockerfile),
        message: `Found multiple Dockerfiles with process type ${processType}. Please choose one to build and push `
      }
      let answer = await Inquirer.prompt(prompt)
      chosenJobs.push(group.find(o => o.dockerfile === answer[processType]))
    } else {
      chosenJobs.push(group[0])
    }
  }
  return chosenJobs
}

Sanbashi.filterByProcessType = function (jobs, procs) {
  let filteredJobs = {}
  procs.forEach((processType) => {
    filteredJobs[processType] = jobs[processType]
  })
  return filteredJobs
}

Sanbashi.buildImage = function (dockerfile, resource, buildArg, path) {
  let cwd = path || Path.dirname(dockerfile)
  let args = ['build', '-f', dockerfile, '-t', resource]

  for (let i = 0; i < buildArg.length; i++) {
    if (buildArg[i].length !== 0) {
      args.push('--build-arg')
      args.push(buildArg[i])
    }
  }

  args.push(cwd)
  return Sanbashi.cmd('docker', args)
}

Sanbashi.pushImage = function (resource, options = {}) {
  let args = ['push', resource]
  return Sanbashi.cmd('docker', args, options)
}

Sanbashi.pullImage = function (resource) {
  let args = ['pull', resource]
  return Sanbashi.cmd('docker', args)
}

Sanbashi.runImage = function (resource, command, port) {
  let args = ['run', '--user', os.userInfo().uid, '-e', `PORT=${port}`]
  if (command === '') {
    args.push(resource)
  } else {
    args.push('-it', resource, command)
  }
  return Sanbashi.cmd('docker', args)
}

Sanbashi.version = function () {
  return Sanbashi
    .cmd('docker', ['version', '-f', '{{.Client.Version}}'], {output: true})
    .then(version => version.split(/\./))
    .then(([major, minor]) => [parseInt(major) || 0, parseInt(minor) || 0]) // ensure exactly 2 components
}

Sanbashi.imageID = function (tag) {
  return Sanbashi
    .cmd('docker', ['inspect', tag, '--format={{.Id}}'], {output: true})
    .then(id => id.trimRight()) // Trim the new line at the end of the string
}

Sanbashi.tag = function (source, target) {
  return Sanbashi
    .cmd('docker', ['tag', source, target])
}

Sanbashi.cmd = function (cmd, args, options = {}) {
  debug(cmd, args)
  let stdio = [process.stdin, process.stdout, process.stderr]
  if (options.input) {
    stdio[0] = 'pipe'
  }
  if (options.output) {
    stdio[1] = 'pipe'
  }
  if (options.error) {
    stdio[2] = 'pipe'
  }

  return new Promise((resolve, reject) => {
    let child = Child.spawn(cmd, args, {stdio: stdio})

    if (child.stdin) {
      child.stdin.end(options.input)
    }
    let stdout
    let stderr
    if (child.stdout) {
      stdout = ''
      child.stdout.on('data', (data) => {
        stdout += data.toString()
      })
    }
    if (child.stderr) {
      stderr = ''
      child.stderr.on('data', (data) => {
        stderr += data.toString()
      })
    }
    child.on('exit', (code, signal) => {
      if (signal || code) {
        let error = {
          code: signal || code,
          error: stderr
        }
        reject(error)
      } else resolve(stdout)
    })
  })
}

module.exports = Sanbashi
