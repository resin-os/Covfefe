'use strict'

const _ = require('lodash')
const imageWriter = require('etcher-image-write')
const mountutils = Promise.promisifyAll(require('mountutils'))
const progress = require('progress-stream')
const bar = require('cli-progress')
const drivelist = require('drivelist')
const fs = require('fs')
const path = require('path')
const lkl = require('lkl')
const filedisk = require('file-disk')
lkl.fs = Promise.promisifyAll(lkl.fs)

const nmWifiConfig = (options) => {
  const ssid = options.wifiSsid.trim()
  if (_.isEmpty(ssid)) {
    return null
  }

  let config = `
    [connection]
    id=resin-wifi
    type=wifi
    [wifi]
    hidden=true
    mode=infrastructure
    ssid=#{options.wifiSsid}
    [ipv4]
    method=auto
    [ipv6]
    addr-gen-mode=stable-privacy
    method=auto
  `

  if (options.wifiKey) {
    config += `
      [wifi-security]
      auth-alg=open
      key-mgmt=wpa-psk
      psk=#{options.wifiKey}
    `
  }

  return config
}

const writeConfigure = (config) => {
  const wifiConfig = nmWifiConfig(config)
  const otherConfig = _.omit(config, 'wifiSsid', 'wifiKey')

  Promise.using(filedisk.openFile(path.join(global.assetDir, 'resin.img'), 'r+'), (fd) => {
    const disk = new filedisk.FileDisk(fd)
    Promise.using(lkl.utils.attachDisk(disk), (diskId) => {
      Promise.using(lkl.utils.mountPartition(diskId, 'vfat'), (mountpoint) => {
        lkl.fs.writeFileAsync(path.join(mountpoint, 'config.json'), JSON.stringify(otherConfig)).then(() => {
          if (wifiConfig) {
            lkl.fs.writeFileAsync(path.join(mountpoint, '/system-connections/resin-wifi'), wifiConfig)
          }
        })
      })
    })
  })
}

const validateDisk = (disk) => {
  return drivelist.listAsync()
    .then((disks) => {
      const result = _.find(disks, {
        device: disk
      })

      if (typeof result === 'undefined') {
        throw new Error(`The selected drive ${disk} was not found`)
      } else {
        return result.device
      }
    })
}

const getImage = (deviceType, version) => {
  const download = new bar.Bar({}, bar.Presets.shades_classic)
  const os = global.resin.models.os

  return new Promise((resolve, reject) => {
    Promise.join(os.download(deviceType, version), os.getDownloadSize(deviceType, version)).spread((stream, size) => {
      fs.access(path.join(global.assetDir, 'resin.img'), fs.constants.F_OK, (err) => {
        if (err) {
          download.start(100, 0)

          const progressStream = progress({
            length: size,
            time: 1000
          })

          stream.pipe(progressStream).pipe(fs.createWriteStream(path.join(global.assetDir, 'resin.img')))

          progressStream.on('progress', (data) => {
            download.update(data.percentage.toFixed(2))
          })

          stream.on('finish', () => {
            download.update(100)
            download.stop()
            resolve()
          })

          stream.on('error', reject)
        } else {
          // Image was found in the asset dir, do not attempt download
          resolve()
        }
      })
    })
  })
}

const writeImage = (disk) => {
  const write = new bar.Bar({}, bar.Presets.shades_classic)
  let fd = null

  return Promise.try(() => {
    return mountutils.unmountDiskAsync(disk)
  }).then(() => {
    return fs.openAsync(disk, 'rs+')
  }).then((driveFileDescriptor) => {
    fd = driveFileDescriptor
    return imageWriter.write({
      fd,
      device: disk,
      size: 2014314496
    },
    {
      stream: fs.createReadStream(path.join(global.assetDir, 'resin.img')),
      size: fs.statSync(path.join(global.assetDir, 'resin.img')).size
    },
    {
      check: false
    })
  }).then((emitter) => {
    return new Promise((resolve, reject) => {
      write.start(100, 0)
      emitter.on('progress', (state) => {
        write.update(state.percentage.toFixed(2))
      })

      emitter.on('error', reject)
      emitter.on('done', (results) => {
        console.log(results)
        write.stop()
        resolve()
      })
    })
  }).tap(() => {
    return fs.closeAsync(fd).then(() => {
      return Promise.delay(2000)
        .return(disk)
        .then(mountutils.unmountDiskAsync)
    })
  })
}

exports.provision = (appName, deviceType, version, disk, config) => {
  return getImage(deviceType, version)
    .then(() => {
      return global.resin.models.os.getConfig(appName, config)
    })
    .then((conf) => {
      return writeConfigure(conf)
    })
    .then(() => {
      return validateDisk(disk)
    })
    .then(writeImage)
}
