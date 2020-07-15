import config from './Config'
import { EVT } from './EVT'
import { store } from './Store'
import { log } from './Log'
import { downloadStates, DLStatesI } from './DownloadStates'
import { Result } from './Store.d'

interface TaskMeta {
  id: number
  url: string
  part: number
}

interface TaskData {
  id: number
  data: Result[]
}

interface TaskStates {
  id: number
  states: DLStatesI
}

// 断点续传。恢复未完成的下载
class Resume {
  constructor() {
    this.init()
  }

  public flag = false // 指示是否处于恢复模式

  private db!: IDBDatabase
  private metaName = 'taskMeta' // 下载任务元数据的表名
  private dataName = 'taskData' // 下载任务数据的表名
  private statesName = 'taskStates' // 下载状态列表的表名
  private taskId!: number // 为当前任务创建一个 id，操作数据库时使用

  private part: number[] = []  // 储存每个分段里的数据的数量

  private try = 0 // 任务结果是分批储存的，记录每批失败了几次。根据失败次数减少每批的数量

  private testData: Result = {
    bmk: 1644,
    bookmarked: false,
    date: "2020-07-11",
    dlCount: 1,
    ext: "jpg",
    fullHeight: 1152,
    fullWidth: 2048,
    id: "82900613_p0",
    idNum: 82900613,
    novelBlob: null,
    pageCount: 1,
    rank: "",
    seriesOrder: "",
    seriesTitle: "",
    tags: ["女の子", "バーチャルYouTuber", "にじさんじ", "本間ひまわり", "にじさんじ", "本間ひまわり"],
    tagsTranslated: ["女の子", "女孩子", "バーチャルYouTuber", "虚拟YouTuber", "にじさんじ", "彩虹社", "本間ひまわり", "本间向日葵", "にじさんじ", "彩虹社", "本間ひまわり", "本间向日葵"],
    thumb: "https://i.pximg.net/c/250x250_80_a2/custom-thumb/img/2020/07/11/17/05/41/82900613_p0_custom1200.jpg",
    title: "本間ひまわり",
    type: 0,
    ugoiraInfo: null,
    url: "https://i.pximg.net/img-original/img/2020/07/11/17/05/41/82900613_p0.jpg",
    user: "らっち。",
    userId: "10852879",
  }

  private async init() {
    this.db = await this.initDB()
    this.restoreData()
    this.bindEvent()
    this.clearExired()
  }

  // 初始化数据库，获取数据库对象
  private async initDB() {
    return new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(config.dbName, 2)

      request.onupgradeneeded = (ev) => {
        // 创建表和索引
        const metaStore = request.result.createObjectStore(this.metaName, {
          keyPath: 'id',
        })
        metaStore.createIndex('id', 'id', { unique: true })
        metaStore.createIndex('url', 'url', { unique: true })

        const dataStore = request.result.createObjectStore(this.dataName, {
          keyPath: 'id',
        })
        dataStore.createIndex('id', 'id', { unique: true })

        const statesStore = request.result.createObjectStore(this.statesName, {
          keyPath: 'id',
        })
        statesStore.createIndex('id', 'id', { unique: true })
      }

      request.onerror = (ev) => {
        console.error('open indexDB failed')
        reject(ev)
      }

      request.onsuccess = (ev) => {
        resolve(request.result)
      }
    })
  }

  // 在数字后面追加数字
  // 用于在 task id  后面追加序号数字(part)
  private numAppendNum(id: number, num: number) {
    return parseInt(id.toString() + num)
  }


  // 恢复未完成任务的数据
  private async restoreData() {
    // 首先获取任务的元数据
    const meta = await this.getMetaDataByURL(this.getURL())
    if (!meta) {
      this.flag = false
      return
    }

    // 恢复下载任务的 id
    this.taskId = meta.id

    // 恢复所有数据

    // 生成每批数据的 id 列表
    const dataIdList: number[] = []
    let part = meta.part

    while (part >= 0) {
      dataIdList.push(this.numAppendNum(this.taskId, part))
      part--
    }

    dataIdList.reverse()  // 因为上面的循环是从大到小，这里翻转成从小到大

    // 读取全部数据并恢复
    const promiseList = []
    for (const id of dataIdList) {
      promiseList.push(this.getData(this.dataName, id))
    }

    Promise.all(promiseList).then(res => {
      console.log(res)
      const r = res as TaskData[]
      for (const data of r) {
        store.result.push(...data.data)
      }
    })

    // 恢复下载状态
    const data = await this.getData(this.statesName, this.taskId) as TaskStates

    if (data) {
      downloadStates.replace(data.states)
    }

    // 恢复模式就绪
    this.flag = true

    // 发出抓取完毕的信号
    EVT.fire(EVT.events.crawlFinish, {
      initiator: EVT.InitiatorList.resume,
    })
  }

  // 计算 part 数组里的数字之和
  private getPartTotal() {
    if (this.part.length === 0) {
      return 0
    }

    return this.part.reduce((prev, curr) => {
      return prev + curr
    })
  }

  // 存储抓取结果
  private async saveTaskData() {
    return new Promise(async (resolve, reject) => {
      // 每一批任务的第一次执行都会尝试保存所有剩余数据
      // 如果出错了，则每次执行会尝试保存上一次的一半数据，直到这批任务成功
      // 之后继续进行下一批任务（如果有）
      const tryNum = Math.floor(store.result.length * (Math.pow(0.5, this.try)))
      let data = {
        id: this.numAppendNum(this.taskId, this.part.length),
        data: store.result.slice(this.getPartTotal(), tryNum)
      }

      try {
        // 当成功存储了一批数据时
        await this.addData(this.dataName, data)
        this.part.push(tryNum)  // 记录这一次保存的结果数量
        this.try = 0  // 重置已尝试次数

        console.log(this.getPartTotal())

        // 任务数据全部添加完毕
        if (this.getPartTotal() === store.result.length) {
          resolve()
        } else {
          // 任务数据没有添加完毕，继续添加
          resolve(this.saveTaskData())
        }
      } catch (error) {
        // 当存储失败时
        console.log(error)
        if (error.target && error.target.error && error.target.error.message) {
          const msg = error.target.error.message as string
          if (msg.includes('too large')) {
            // 体积超大
            // 尝试次数 + 1 ，进行下一次尝试
            this.try++
            resolve(this.saveTaskData())
          } else {
            // 未知错误，不再进行尝试
            this.try = 0
            log.error(msg)
            reject(error)
          }
        }
      }

    })
  }


  private bindEvent() {
    // 抓取完成时，保存这次任务的数据
    window.addEventListener(
      EVT.events.crawlFinish,
      async (ev: CustomEventInit) => {
        if (ev.detail.data.initiator === EVT.InitiatorList.resume) {
          // 如果这个事件是这个类自己发出的，则不进行处理
          return
        }
        // 首先检查这个网址下是否已经存在有数据，如果有数据，则清除之前的数据，保持每个网址只有一份数据
        const taskData = await this.getMetaDataByURL(this.getURL())
        if (taskData) {
          await this.deleteData(this.metaName, taskData.id)
          await this.deleteData(this.statesName, taskData.id)
        }

        this.taskId = new Date().getTime()

        // 保存本次任务的数据
        await this.saveTaskData()

        // 保存 meta 数据
        const metaData = {
          id: this.taskId,
          url: this.getURL(),
          part: this.part.length,
        }

        this.addData(this.metaName, metaData)

        // 保存 states 数据
        const statesData = {
          id: this.taskId,
          states: downloadStates.states,
        }
        this.addData(this.statesName, statesData)
      }
    )

    // 当有文件下载完成时，保存下载状态
    window.addEventListener(
      EVT.events.downloadSucccess,
      (event: CustomEventInit) => {
        const statesData = {
          id: this.taskId,
          states: downloadStates.states,
        }
        this.putData(this.statesName, statesData)
      }
    )

    // 任务下载完毕时，清除这次任务的数据
    window.addEventListener(EVT.events.downloadComplete, () => {
      this.deleteData(this.metaName, this.taskId)
      this.deleteData(this.statesName, this.taskId)

      this.flag = false
    })

    // 开始新的抓取时，取消恢复模式
    window.addEventListener(EVT.events.crawlStart, () => {
      this.flag = false

      this.part = []
    })
  }

  // 处理本页面的 url
  private getURL() {
    return window.location.href.split('#')[0]
  }

  // 根据 url，查找任务数据
  private async getMetaDataByURL(url: string) {
    return new Promise<TaskMeta | null>((resolve) => {
      const s = this.db
        .transaction(this.metaName, 'readonly')
        .objectStore(this.metaName)
      const r = s.index('url').get(url)

      r.onsuccess = (ev) => {
        const data = r.result as TaskMeta
        if (data) {
          resolve(data)
        }
        resolve(null)
      }
    })
  }

  // 查找数据
  private async getData(storeNames: string, index: any) {
    return new Promise((resolve, reject) => {
      const r = this.db
        .transaction(storeNames, 'readonly')
        .objectStore(storeNames)
        .get(index)

      r.onsuccess = (ev) => {
        const data = r.result
        if (data) {
          resolve(data)
        }
        resolve(null)
      }

      r.onerror = (ev) => {
        console.error('add failed')
        reject(ev)
      }
    })
  }

  // 写入新的记录
  private async addData(storeNames: string, data: TaskMeta | TaskData | TaskStates) {
    return new Promise((resolve, reject) => {
      const r = this.db
        .transaction(storeNames, 'readwrite')
        .objectStore(storeNames)
        .add(data)

      r.onsuccess = (ev) => {
        resolve(ev)
      }
      r.onerror = (ev) => {
        console.error('add failed')
        reject(ev)
      }
    })
  }

  // 更新已有记录
  // 目前只需要更新下载状态列表。因为任务数据只在抓取完成后保存一次即可。
  private async putData(storeNames: string, data: TaskMeta | TaskStates) {
    return new Promise((resolve, reject) => {
      const r = this.db
        .transaction(storeNames, 'readwrite')
        .objectStore(storeNames)
        .put(data)
      r.onsuccess = (ev) => {
        resolve(ev)
      }
      r.onerror = (ev) => {
        console.error('put failed')
        reject(ev)
      }
    })
  }

  private async deleteData(storeNames: string, id: number) {
    return new Promise((resolve, reject) => {
      const r = this.db
        .transaction(storeNames, 'readwrite')
        .objectStore(storeNames)
        .delete(id)

      r.onsuccess = (ev) => {
        resolve(ev)
      }
      r.onerror = (ev) => {
        console.error('delete failed')
        reject(ev)
      }
    })
  }

  // 清除过期的数据
  private clearExired() {
    // 数据的过期时间，设置为 30 天。30*24*60*60*1000
    const expiryTime = 2592000000

    const nowTime = new Date().getTime()

    const r = this.db
      .transaction(this.metaName)
      .objectStore(this.metaName)
      .openCursor()

    r.onsuccess = (ev) => {
      if (r.result) {
        const data = r.result.value as TaskMeta
        // 删除过期的数据
        if (nowTime - data.id > expiryTime) {
          this.deleteData(this.metaName, data.id)
          this.deleteData(this.statesName, data.id)
        }
        r.result.continue()
      }
    }
    r.onerror = (ev) => {
      console.error('openCursor failed')
    }
  }
}

const resume = new Resume()
export { resume }
