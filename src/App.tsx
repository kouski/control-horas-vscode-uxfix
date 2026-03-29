import { useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from './supabase'

type DayEntry = {
  workedHours: number
  observation: string
  isHoliday: boolean
}

type Worker = {
  id: string
  name: string
  role: string
  overtimeNormalRate: number
  overtimeFestiveRate: number
  monthlyCities: Record<string, string>
  entries: Record<string, DayEntry>
}

type AppData = {
  workers: Worker[]
}

type MonthlyPayroll = {
  totalWorkedHours: number
  totalOvertimeNormalHours: number
  totalOvertimeFestiveHours: number
  overtimeNormalPay: number
  overtimeFestivePay: number
  totalPay: number
  citiesText: string
}

const STORAGE_KEY = 'control-horas-extras-v2'
const MAX_WORKERS = 20
const WEEKLY_REGULAR_HOURS = 40
const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']
const DAY_NAMES = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom']

const defaultDayEntry: DayEntry = { workedHours: 0, observation: '', isHoliday: false }

const initialData: AppData = {
  workers: [
    {
      id: crypto.randomUUID(),
      name: 'Operario 1',
      role: 'Operario',
      overtimeNormalRate: 15.57,
      overtimeFestiveRate: 18.35,
      monthlyCities: {},
      entries: {},
    },
  ],
}

function numberOrZero(value: string | number | undefined) {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function currency(value: number) {
  return new Intl.NumberFormat('es-ES', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
  }).format(value || 0)
}

function formatDateKey(year: number, month: number, day: number) {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

function parseDateKey(dateKey: string) {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function getMonthKey(year: number, month: number) {
  return `${year}-${String(month + 1).padStart(2, '0')}`
}

function getDaysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate()
}

function getIsoWeekKey(date: Date) {
  const temp = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = temp.getUTCDay() || 7
  temp.setUTCDate(temp.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(temp.getUTCFullYear(), 0, 1))
  const weekNo = Math.ceil((((temp.getTime() - yearStart.getTime()) / 86400000) + 1) / 7)
  return `${temp.getUTCFullYear()}-W${weekNo}`
}

function isWeekend(date: Date) {
  const day = date.getDay()
  return day === 0 || day === 6
}

function loadData(): AppData {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return initialData
    const parsed = JSON.parse(raw) as AppData
    if (!parsed?.workers) return initialData
    return {
      workers: parsed.workers.map((worker) => ({
        ...worker,
        monthlyCities: worker.monthlyCities || {},
        entries: Object.fromEntries(
          Object.entries(worker.entries || {}).map(([key, entry]) => [
            key,
            {
              workedHours: numberOrZero(entry?.workedHours),
              observation: entry?.observation || '',
              isHoliday: Boolean(entry?.isHoliday),
            },
          ]),
        ),
      })),
    }
  } catch {
    return initialData
  }
}

async function syncToSupabase(data: AppData) {
  // Helper to migrate or full sync if needed
  for (const worker of data.workers) {
    const { error: wError } = await supabase
      .from('workers')
      .upsert({
        id: worker.id,
        name: worker.name,
        role: worker.role,
        overtime_normal_rate: worker.overtimeNormalRate,
        overtime_festive_rate: worker.overtimeFestiveRate,
      })

    if (wError) console.error('Error syncing worker:', wError)

    // Sync entries
    const entriesToUpsert = Object.entries(worker.entries).map(([dateKey, entry]) => ({
      worker_id: worker.id,
      date: dateKey,
      worked_hours: entry.workedHours,
      observation: entry.observation,
      is_holiday: entry.isHoliday,
    }))

    if (entriesToUpsert.length > 0) {
      const { error: eError } = await supabase
        .from('entries')
        .upsert(entriesToUpsert, { onConflict: 'worker_id,date' })
      if (eError) console.error('Error syncing entries:', eError)
    }

    // Sync cities
    const citiesToUpsert = Object.entries(worker.monthlyCities).map(([monthKey, text]) => ({
      worker_id: worker.id,
      month_key: monthKey,
      cities_text: text,
    }))

    if (citiesToUpsert.length > 0) {
      const { error: cError } = await supabase
        .from('monthly_cities')
        .upsert(citiesToUpsert, { onConflict: 'worker_id,month_key' })
      if (cError) console.error('Error syncing cities:', cError)
    }
  }
}

function getEntry(worker: Worker, dateKey: string): DayEntry {
  return worker.entries[dateKey] || defaultDayEntry
}

function calculateMonthlyPayroll(worker: Worker, year: number, month: number): MonthlyPayroll {
  const monthPrefix = `${year}-${String(month + 1).padStart(2, '0')}-`
  const monthEntries = Object.entries(worker.entries)
    .filter(([dateKey]) => dateKey.startsWith(monthPrefix))
    .map(([dateKey, entry]) => ({ dateKey, entry, date: parseDateKey(dateKey) }))
    .sort((a, b) => a.date.getTime() - b.date.getTime())

  const weeklyBuckets = new Map<string, typeof monthEntries>()
  let totalWorkedHours = 0

  monthEntries.forEach((item) => {
    totalWorkedHours += numberOrZero(item.entry.workedHours)
    const weekKey = getIsoWeekKey(item.date)
    if (!weeklyBuckets.has(weekKey)) weeklyBuckets.set(weekKey, [])
    weeklyBuckets.get(weekKey)!.push(item)
  })

  let totalOvertimeNormalHours = 0
  let totalOvertimeFestiveHours = 0

  weeklyBuckets.forEach((items) => {
    // Festivos entre semana (L-V marcados como festivo): reducen el umbral 8 h cada uno
    const weekdayHolidays = items.filter(
      ({ date, entry }) => !isWeekend(date) && entry.isHoliday
    ).length
    const weeklyThreshold = WEEKLY_REGULAR_HOURS - weekdayHolidays * 8

    const weekdayHours = items
      .filter(({ date, entry }) => !isWeekend(date) && !entry.isHoliday)
      .reduce((sum, item) => sum + numberOrZero(item.entry.workedHours), 0)

    const festiveHours = items
      .filter(({ date, entry }) => isWeekend(date) || entry.isHoliday)
      .reduce((sum, item) => sum + numberOrZero(item.entry.workedHours), 0)

    totalOvertimeNormalHours += Math.max(0, weekdayHours - weeklyThreshold)
    totalOvertimeFestiveHours += festiveHours
  })

  const overtimeNormalPay = totalOvertimeNormalHours * numberOrZero(worker.overtimeNormalRate)
  const overtimeFestivePay = totalOvertimeFestiveHours * numberOrZero(worker.overtimeFestiveRate)

  return {
    totalWorkedHours,
    totalOvertimeNormalHours,
    totalOvertimeFestiveHours,
    overtimeNormalPay,
    overtimeFestivePay,
    totalPay: overtimeNormalPay + overtimeFestivePay,
    citiesText: worker.monthlyCities[getMonthKey(year, month)] || '',
  }
}

function calculateAnnualPayroll(worker: Worker, year: number) {
  let totalWorkedHours = 0
  let totalOvertimeNormalHours = 0
  let totalOvertimeFestiveHours = 0
  let totalPay = 0

  for (let month = 0; month < 12; month += 1) {
    const monthly = calculateMonthlyPayroll(worker, year, month)
    totalWorkedHours += monthly.totalWorkedHours
    totalOvertimeNormalHours += monthly.totalOvertimeNormalHours
    totalOvertimeFestiveHours += monthly.totalOvertimeFestiveHours
    totalPay += monthly.totalPay
  }

  return { totalWorkedHours, totalOvertimeNormalHours, totalOvertimeFestiveHours, totalPay }
}

function DayCell({
  entry,
  festive,
  onHoursChange,
  onHoursBlur,
  onOpenMeta,
}: {
  entry: DayEntry
  festive: boolean
  onHoursChange: (hours: number) => void
  onHoursBlur: () => void
  onOpenMeta: () => void
}) {
  return (
    <div className={`day-cell ${festive ? 'day-cell-festive' : ''}`} onDoubleClick={onOpenMeta}>
      <input
        className="day-hours-input"
        type="number"
        min="0"
        step="0.25"
        value={entry.workedHours === 0 ? '' : String(entry.workedHours)}
        onChange={(e) => onHoursChange(numberOrZero(e.target.value))}
        onBlur={onHoursBlur}
        aria-label="Horas trabajadas del día"
      />
      <span className="day-cell-note">{entry.observation ? 'Obs' : ''}</span>
    </div>
  )
}

function DayMetaModal({
  open,
  entry,
  onClose,
  onSave,
}: {
  open: boolean
  entry: DayEntry
  onClose: () => void
  onSave: (entry: DayEntry) => void
}) {
  const [observation, setObservation] = useState(entry.observation)
  const [isHoliday, setIsHoliday] = useState(entry.isHoliday)

  useEffect(() => {
    setObservation(entry.observation)
    setIsHoliday(entry.isHoliday)
  }, [entry])

  if (!open) return null

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card modal-card-compact" onClick={(e) => e.stopPropagation()}>
        <h3>Detalle del día</h3>
        <label>
          Observaciones
          <textarea value={observation} onChange={(e) => setObservation(e.target.value)} rows={4} />
        </label>
        <label className="checkbox-row">
          <input type="checkbox" checked={isHoliday} onChange={(e) => setIsHoliday(e.target.checked)} />
          Marcar como festivo manual
        </label>
        <div className="modal-actions">
          <button className="secondary" onClick={onClose}>Cancelar</button>
          <button onClick={() => onSave({ ...entry, observation, isHoliday })}>Guardar</button>
        </div>
      </div>
    </div>
  )
}

export default function App() {
  const today = new Date()
  const [data, setData] = useState<AppData>(initialData)
  const [currentYear, setCurrentYear] = useState(today.getFullYear())
  const [currentMonth, setCurrentMonth] = useState(today.getMonth())
  const [selectedWorkerId, setSelectedWorkerId] = useState('')
  const [newWorkerName, setNewWorkerName] = useState('')
  const [newWorkerRole, setNewWorkerRole] = useState('')
  const [newNormalRate, setNewNormalRate] = useState('15.57')
  const [newFestiveRate, setNewFestiveRate] = useState('18.35')
  const [editingCitiesWorkerId, setEditingCitiesWorkerId] = useState<string | null>(null)
  const [citiesDraft, setCitiesDraft] = useState('')
  const [lastSavedAt, setLastSavedAt] = useState('')
  const [loading, setLoading] = useState(true)
  const [metaOpen, setMetaOpen] = useState(false)
  const [metaWorkerId, setMetaWorkerId] = useState('')
  const [metaDateKey, setMetaDateKey] = useState('')

  async function loadFromSupabase() {
    try {
      setLoading(true)
      const { data: workers, error: wError } = await supabase.from('workers').select('*')
      if (wError) throw wError

      const { data: entries, error: eError } = await supabase.from('entries').select('*')
      if (eError) throw eError

      const { data: cities, error: cError } = await supabase.from('monthly_cities').select('*')
      if (cError) throw cError

      const formattedWorkers: Worker[] = workers.map((w: any) => {
        const workerEntries: Record<string, DayEntry> = {}
        entries
          .filter((e: any) => e.worker_id === w.id)
          .forEach((e: any) => {
            workerEntries[e.date] = {
              workedHours: numberOrZero(e.worked_hours),
              observation: e.observation || '',
              isHoliday: Boolean(e.is_holiday),
            }
          })

        const workerCities: Record<string, string> = {}
        cities
          .filter((c: any) => c.worker_id === w.id)
          .forEach((c: any) => {
            workerCities[c.month_key] = c.cities_text || ''
          })

        return {
          id: w.id,
          name: w.name,
          role: w.role || '',
          overtimeNormalRate: numberOrZero(w.overtime_normal_rate),
          overtimeFestiveRate: numberOrZero(w.overtime_festive_rate),
          entries: workerEntries,
          monthlyCities: workerCities,
        }
      })

      if (formattedWorkers.length > 0) {
        setData({ workers: formattedWorkers })
        setSelectedWorkerId(formattedWorkers[0].id)
      } else {
        // Check if there's local data to migrate
        const local = loadData()
        if (local.workers.length > 0 && local.workers[0].name !== 'Operario 1') {
          console.log('Migrating local data to Supabase...')
          await syncToSupabase(local)
          setData(local)
          setSelectedWorkerId(local.workers[0].id)
        } else {
          setData(initialData)
          setSelectedWorkerId(initialData.workers[0].id)
        }
      }
    } catch (err) {
      console.error('Error loading from Supabase:', err)
      setData(loadData()) // Fallback to local
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadFromSupabase()
  }, [])

  useEffect(() => {
    if (!loading) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
      setLastSavedAt(new Date().toLocaleString('es-ES'))
    }
  }, [data, loading])

  const selectedWorker = useMemo(
    () => data.workers.find((w) => w.id === selectedWorkerId) || data.workers[0],
    [data.workers, selectedWorkerId],
  )

  const selectedMonthly = selectedWorker ? calculateMonthlyPayroll(selectedWorker, currentYear, currentMonth) : null
  const selectedAnnual = selectedWorker ? calculateAnnualPayroll(selectedWorker, currentYear) : null

  const daysInMonth = getDaysInMonth(currentYear, currentMonth)
  const dayNumbers = Array.from({ length: daysInMonth }, (_, i) => i + 1)

  const syncTimeouts = useRef<Record<string, any>>({})
  const pendingUpdates = useRef<Record<string, DayEntry>>({})

  async function updateWorker(workerId: string, updater: (worker: Worker) => Worker) {
    const currentWorker = data.workers.find(w => w.id === workerId)
    if (!currentWorker) return
    const updated = updater(currentWorker)

    setData((prev) => ({
      ...prev,
      workers: prev.workers.map((w) => (w.id === workerId ? updated : w)),
    }))

    const { error } = await supabase.from('workers').upsert({
      id: updated.id,
      name: updated.name,
      role: updated.role,
      overtime_normal_rate: updated.overtimeNormalRate,
      overtime_festive_rate: updated.overtimeFestiveRate,
    })
    if (error) console.error('Error updating worker:', error)
  }

  function updateDay(workerId: string, dateKey: string, entry: DayEntry, force: boolean = false) {
    // 1. Update local state immediately
    setData((prev) => ({
      ...prev,
      workers: prev.workers.map((w) => {
        if (w.id !== workerId) return w
        return {
          ...w,
          entries: { ...w.entries, [dateKey]: entry },
        }
      }),
    }))

    // 2. Debounce or Force Supabase sync
    const syncKey = `${workerId}:${dateKey}`
    if (syncTimeouts.current[syncKey]) {
      clearTimeout(syncTimeouts.current[syncKey])
    }

    pendingUpdates.current[syncKey] = entry

    const performSync = async () => {
      const latestEntry = pendingUpdates.current[syncKey]
      if (!latestEntry) return

      const { error } = await supabase
        .from('entries')
        .upsert({
          worker_id: workerId,
          date: dateKey,
          worked_hours: latestEntry.workedHours,
          observation: latestEntry.observation,
          is_holiday: latestEntry.isHoliday,
        }, { onConflict: 'worker_id,date' })
      if (error) {
        console.error('Error updating day in Supabase:', error)
      } else {
        delete pendingUpdates.current[syncKey]
      }
      delete syncTimeouts.current[syncKey]
    }

    if (force) {
      performSync()
    } else {
      syncTimeouts.current[syncKey] = setTimeout(performSync, 1000)
    }
  }

  async function updateMonthlyCities(workerId: string, text: string) {
    const monthKey = getMonthKey(currentYear, currentMonth)
    updateWorker(workerId, (worker) => ({
      ...worker,
      monthlyCities: { ...worker.monthlyCities, [monthKey]: text },
    }))

    const { error } = await supabase.from('monthly_cities').upsert({
      worker_id: workerId,
      month_key: monthKey,
      cities_text: text,
    })
    if (error) console.error('Error updating cities:', error)
  }

  async function addWorker() {
    if (!newWorkerName.trim() || data.workers.length >= MAX_WORKERS) return
    const worker: Worker = {
      id: crypto.randomUUID(),
      name: newWorkerName.trim(),
      role: newWorkerRole.trim(),
      overtimeNormalRate: numberOrZero(newNormalRate),
      overtimeFestiveRate: numberOrZero(newFestiveRate),
      monthlyCities: {},
      entries: {},
    }
    setData((prev) => ({ ...prev, workers: [...prev.workers, worker] }))
    setSelectedWorkerId(worker.id)
    setNewWorkerName('')
    setNewWorkerRole('')
    setNewNormalRate('15.57')
    setNewFestiveRate('18.35')

    const { error } = await supabase.from('workers').insert({
      id: worker.id,
      name: worker.name,
      role: worker.role,
      overtime_normal_rate: worker.overtimeNormalRate,
      overtime_festive_rate: worker.overtimeFestiveRate,
    })
    if (error) console.error('Error adding worker:', error)
  }

  async function removeWorker(workerId: string) {
    const nextWorkers = data.workers.filter((w) => w.id !== workerId)
    setData({ ...data, workers: nextWorkers })
    if (selectedWorkerId === workerId) setSelectedWorkerId(nextWorkers[0]?.id || '')

    const { error } = await supabase.from('workers').delete().eq('id', workerId)
    if (error) console.error('Error removing worker:', error)
  }

  function changeMonth(direction: number) {
    const next = new Date(currentYear, currentMonth + direction, 1)
    setCurrentYear(next.getFullYear())
    setCurrentMonth(next.getMonth())
    setEditingCitiesWorkerId(null)
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `control-horas-${currentYear}-${currentMonth + 1}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  function importJson(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = async () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as AppData
        if (parsed?.workers) {
          setData(parsed)
          setSelectedWorkerId(parsed.workers[0]?.id || '')

          // Sync restored data to Supabase immediately after import
          setLoading(true)
          await syncToSupabase(parsed)
          setLoading(false)
          alert('Datos restaurados y sincronizados con éxito.')
        }
      } catch (err) {
        console.error('Error importing JSON:', err)
        setLoading(false)
        alert('Error al restaurar los datos.')
      }
    }
    reader.readAsText(file)
  }

  function handlePrint() {
    window.print()
  }

  const activeMetaEntry = useMemo(() => {
    const worker = data.workers.find((w) => w.id === metaWorkerId)
    if (!worker || !metaDateKey) return defaultDayEntry
    return getEntry(worker, metaDateKey)
  }, [data.workers, metaWorkerId, metaDateKey])

  const workerRows = useMemo(
    () => data.workers.map((worker) => ({ worker, monthly: calculateMonthlyPayroll(worker, currentYear, currentMonth) })),
    [data.workers, currentYear, currentMonth],
  )

  const grandTotalPay = useMemo(
    () => workerRows.reduce((sum, { monthly }) => sum + monthly.totalPay, 0),
    [workerRows],
  )

  return (
    <div className="app-shell">
      {loading && (
        <div className="modal-backdrop" style={{ zIndex: 100 }}>
          <div className="modal-card" style={{ textAlign: 'center' }}>
            <h2>Cargando datos...</h2>
            <p>Sincronizando con Supabase</p>
          </div>
        </div>
      )}
      <header className="topbar">
        <div>
          <h1>Control de horas extra</h1>
          <p className="month-title">{MONTHS[currentMonth]} {currentYear}</p>
          <small className="save-status">{lastSavedAt ? `Último guardado: ${lastSavedAt}` : 'Guardado automático activado'}</small>
        </div>
        <div className="toolbar">
          <button className="button button-secondary" onClick={() => changeMonth(-1)}>‹ Mes anterior</button>
          <button className="button button-secondary" onClick={() => changeMonth(1)}>Mes siguiente ›</button>
          <button className="button" onClick={exportJson}>Crear copia de seguridad</button>
          <label className="file-button button button-secondary">
            Restaurar copia
            <input type="file" accept="application/json" onChange={importJson} hidden />
          </label>
        </div>
      </header>

      <div className="layout">
        <aside className="sidebar">
          <section className="card">
            <div className="card-header"><h2>Personal</h2></div>
            <label>
              Trabajador activo
              <select value={selectedWorkerId} onChange={(e) => setSelectedWorkerId(e.target.value)}>
                {data.workers.map((worker) => (
                  <option key={worker.id} value={worker.id}>{worker.name}</option>
                ))}
              </select>
            </label>

            <div className="worker-list">
              {data.workers.map((worker) => (
                <div key={worker.id} className={`worker-item ${selectedWorkerId === worker.id ? 'active' : ''}`}>
                  <button className="worker-main" onClick={() => setSelectedWorkerId(worker.id)}>
                    <div className="worker-name">{worker.name}</div>
                    <div className="worker-role">{worker.role || 'Sin cargo'}</div>
                  </button>
                  <button className="icon-button" onClick={() => removeWorker(worker.id)} title="Eliminar trabajador">×</button>
                </div>
              ))}
            </div>

            <div className="divider" />

            <div className="card-header"><h3>Añadir trabajador</h3></div>
            <input value={newWorkerName} onChange={(e) => setNewWorkerName(e.target.value)} placeholder="Nombre y apellidos" />
            <input value={newWorkerRole} onChange={(e) => setNewWorkerRole(e.target.value)} placeholder="Cargo / categoría" />
            <div className="two-cols">
              <div>
                <label>€/h extra L-V</label>
                <input value={newNormalRate} onChange={(e) => setNewNormalRate(e.target.value)} type="number" step="0.01" />
              </div>
              <div>
                <label>€/h extra festiva</label>
                <input value={newFestiveRate} onChange={(e) => setNewFestiveRate(e.target.value)} type="number" step="0.01" />
              </div>
            </div>
            <button className="button full-width" onClick={addWorker}>Añadir trabajador</button>
            <small className="muted">Máximo 20 personas.</small>
          </section>
        </aside>

        <main className="content">
          {selectedWorker && selectedMonthly && (
            <section className="summary-grid">
              <div className="summary-card"><span>Horas totales mes</span><strong>{selectedMonthly.totalWorkedHours}</strong></div>
              <div className="summary-card"><span>Extras L-V</span><strong>{selectedMonthly.totalOvertimeNormalHours}</strong></div>
              <div className="summary-card green"><span>Extras festivas</span><strong>{selectedMonthly.totalOvertimeFestiveHours}</strong></div>
              <div className="summary-card"><span>Pago total extras mes</span><strong>{currency(selectedMonthly.totalPay)}</strong></div>
            </section>
          )}

          <section className="card matrix-card">
            <div className="card-header"><h2>Vista mensual</h2></div>
            <div className="matrix-wrap">
              <table className="matrix-table">
                <thead>
                  <tr>
                    <th className="sticky-col name-col">Trabajador</th>
                    {dayNumbers.map((day) => {
                      const date = new Date(currentYear, currentMonth, day)
                      const weekend = isWeekend(date)
                      return (
                        <th key={day} className={weekend ? 'weekend-header' : ''}>
                          <div>{day}</div>
                          <small>{DAY_NAMES[(date.getDay() + 6) % 7]}</small>
                        </th>
                      )
                    })}
                    <th>Horas</th>
                    <th>Extra L-V</th>
                    <th className="weekend-header">Extra F</th>
                    <th>€ Total extras</th>
                    <th>Ciudades</th>
                  </tr>
                </thead>
                <tbody>
                  {workerRows.map(({ worker, monthly }) => (
                    <tr key={worker.id}>
                      <td className="sticky-col name-col">
                        <button className="worker-summary" onClick={() => setSelectedWorkerId(worker.id)}>
                          <strong>{worker.name}</strong>
                          <small>{worker.role || 'Sin cargo'}</small>
                        </button>
                      </td>
                      {dayNumbers.map((day) => {
                        const dateKey = formatDateKey(currentYear, currentMonth, day)
                        const entry = getEntry(worker, dateKey)
                        const date = new Date(currentYear, currentMonth, day)
                        const festiveCell = isWeekend(date) || entry.isHoliday
                        return (
                          <td key={dateKey} className={festiveCell ? 'weekend-cell' : ''}>
                            <DayCell
                              entry={entry}
                              festive={festiveCell}
                              onHoursChange={(hours) => updateDay(worker.id, dateKey, { ...entry, workedHours: hours })}
                              onHoursBlur={() => updateDay(worker.id, dateKey, entry, true)}
                              onOpenMeta={() => {
                                setMetaWorkerId(worker.id)
                                setMetaDateKey(dateKey)
                                setMetaOpen(true)
                              }}
                            />
                          </td>
                        )
                      })}
                      <td>{monthly.totalWorkedHours}</td>
                      <td>{monthly.totalOvertimeNormalHours}</td>
                      <td className="weekend-cell">{monthly.totalOvertimeFestiveHours}</td>
                      <td>{currency(monthly.totalPay)}</td>
                      <td>
                        {editingCitiesWorkerId === worker.id ? (
                          <div className="cities-edit">
                            <input value={citiesDraft} onChange={(e) => setCitiesDraft(e.target.value)} placeholder="Madrid, Toledo, Barajas" />
                            <button className="button" onClick={() => { updateMonthlyCities(worker.id, citiesDraft); setEditingCitiesWorkerId(null) }}>Guardar</button>
                          </div>
                        ) : (
                          <button
                            className="cities-cell"
                            onDoubleClick={() => {
                              setEditingCitiesWorkerId(worker.id)
                              setCitiesDraft(monthly.citiesText || '')
                            }}
                          >
                            {monthly.citiesText || 'Doble clic para añadir ciudades del mes'}
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {selectedWorker && selectedMonthly && selectedAnnual && (
            <div className="bottom-grid">
              <section className="card detail-card">
                <div className="card-header"><h2>Resumen mensual de extras</h2></div>
                <div className="detail-grid">
                  <div className="detail-item"><span>Horas trabajadas</span><strong>{selectedMonthly.totalWorkedHours}</strong></div>
                  <div className="detail-item"><span>Horas extra lunes-viernes</span><strong>{selectedMonthly.totalOvertimeNormalHours}</strong></div>
                  <div className="detail-item"><span>Horas extra festivas</span><strong>{selectedMonthly.totalOvertimeFestiveHours}</strong></div>
                  <div className="detail-item"><span>Pago extra L-V</span><strong>{currency(selectedMonthly.overtimeNormalPay)}</strong></div>
                  <div className="detail-item"><span>Pago extra festiva</span><strong>{currency(selectedMonthly.overtimeFestivePay)}</strong></div>
                  <div className="detail-item"><span>Pago total de extras del mes</span><strong>{currency(selectedMonthly.totalPay)}</strong></div>
                </div>
              </section>

              <section className="card detail-card">
                <div className="card-header"><h2>Reglas aplicadas</h2></div>
                <p className="muted">
                  Se contabilizan <strong>8 horas diarias</strong> como jornada ordinaria. El umbral semanal es de <strong>40 h</strong> para una semana completa, <strong>32 h</strong> si hay 1 festivo entre semana y <strong>24 h</strong> si hay 2 festivos entre semana.
                  Los días marcados como festivo en fin de semana o entre semana cuentan como hora extra festiva.
                  Ejemplo: semana con 2 festivos entre semana y 8+9+9 horas trabajadas → 26 h − 24 h = <strong>2 h extra</strong>.
                </p>
                <div className="info-line"><strong>Ciudades del mes:</strong> <span>{selectedMonthly.citiesText || 'No hay ciudades registradas este mes.'}</span></div>
              </section>

              <section className="card annual-card full-width-card">
                <div className="card-header"><h2>Resumen anual</h2></div>
                <div className="annual-grid">
                  <div className="summary-card"><span>Horas totales</span><strong>{selectedAnnual.totalWorkedHours}</strong></div>
                  <div className="summary-card"><span>Extra L-V</span><strong>{selectedAnnual.totalOvertimeNormalHours}</strong></div>
                  <div className="summary-card green"><span>Extra festiva</span><strong>{selectedAnnual.totalOvertimeFestiveHours}</strong></div>
                  <div className="summary-card"><span>€ total extras anual</span><strong>{currency(selectedAnnual.totalPay)}</strong></div>
                </div>
              </section>
            </div>
          )}

          <section className="report-section">
            <div className="report-header">
              <h2>Resumen de Cobros - {MONTHS[currentMonth]} {currentYear}</h2>
              <button className="button" onClick={handlePrint}>Imprimir Listado</button>
            </div>
            <div className="matrix-wrap">
              <table className="report-table">
                <thead>
                  <tr>
                    <th>Nombre y Apellidos</th>
                    <th className="text-right">H. Extra L-V</th>
                    <th className="text-right">H. Extra F</th>
                    <th className="text-right">Total a Cobrar</th>
                    <th>Ciudades</th>
                  </tr>
                </thead>
                <tbody>
                  {workerRows.map(({ worker, monthly }) => (
                    <tr key={worker.id}>
                      <td><strong>{worker.name}</strong><br /><small>{worker.role}</small></td>
                      <td className="text-right">{monthly.totalOvertimeNormalHours}</td>
                      <td className="text-right">{monthly.totalOvertimeFestiveHours}</td>
                      <td className="text-right"><strong>{currency(monthly.totalPay)}</strong></td>
                      <td><small>{monthly.citiesText || '-'}</small></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="total-row">
                    <td colSpan={3} className="text-right"><strong>TOTAL A COBRAR:</strong></td>
                    <td className="text-right"><strong>{currency(grandTotalPay)}</strong></td>
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </section>
        </main>
      </div>

      <DayMetaModal
        open={metaOpen}
        entry={activeMetaEntry}
        onClose={() => setMetaOpen(false)}
        onSave={(entry) => {
          if (metaWorkerId && metaDateKey) updateDay(metaWorkerId, metaDateKey, entry, true)
          setMetaOpen(false)
        }}
      />
    </div>
  )
}
