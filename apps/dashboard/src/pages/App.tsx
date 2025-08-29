import React, { useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import { generateNonce, SiweMessage } from 'siwe'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis, BarChart, Bar, Legend } from 'recharts'
import { ethers } from 'ethers'

const baseURL = window.location.hostname === 'localhost'
  ? 'http://localhost:4000'
  : 'http://api:4000'

const api = axios.create({ baseURL })

function useAuth() {
  const [token, setToken] = useState<string | null>(localStorage.getItem('jwt'))
  const [address, setAddress] = useState<string | null>(localStorage.getItem('address'))

  const headers = useMemo(() => token ? { Authorization: `Bearer ${token}` } : {}, [token])

  const login = async () => {
    if (!(window as any).ethereum) {
      alert('No wallet found. Please install MetaMask.');
      return;
    }
    const [addr] = await (window as any).ethereum.request({ method: 'eth_requestAccounts' })
    const checksummedAddr = ethers.getAddress(addr)
    const { data: { nonce } } = await api.post('/auth/nonce', { address: checksummedAddr })
    console.log('address: ', checksummedAddr);
    const msg = new SiweMessage({
      domain: window.location.host,
      address: checksummedAddr,
      statement: 'Sign in to Gas Cost Monitor',
      uri: window.location.origin,
      version: '1',
      chainId: 1,
      nonce,
    })
    const signature = await (window as any).ethereum.request({ method: 'personal_sign', params: [msg.prepareMessage(), addr] })
    const { data } = await api.post('/auth/verify', { message: msg, signature })
    localStorage.setItem('jwt', data.token)
    localStorage.setItem('address', data.address)
    setToken(data.token)
    setAddress(data.address)
  }

  const logout = () => {
    localStorage.removeItem('jwt');
    localStorage.removeItem('address');
    setToken(null); setAddress(null);
  }

  return { token, address, headers, login, logout }
}

export default function App() {
  const { token, address, headers, login, logout } = useAuth()
  const [owner, setOwner] = useState('')
  const [repo, setRepo] = useState('')
  const [branch, setBranch] = useState('main')
  const [repos, setRepos] = useState<any[]>([])
  const [branches, setBranches] = useState<string[]>([])

  const [reports, setReports] = useState<any[]>([])
  const [left, setLeft] = useState<string>('')
  const [right, setRight] = useState<string>('')
  const [comparison, setComparison] = useState<any | null>(null)
  const comparisonData = useMemo(() => {
    if (!comparison?.left?.report || !comparison?.right?.report) return []
    const leftIdx: Record<string, number> = {}
    for (const item of comparison.left.report) {
      leftIdx[`${item.contract}.${item.method}`] = item.executionGasAverage
    }
    const keys = new Set<string>()
    for (const item of comparison.left.report) keys.add(`${item.contract}.${item.method}`)
    for (const item of comparison.right.report) keys.add(`${item.contract}.${item.method}`)
    const rows: any[] = []
    for (const k of keys) {
      const [contract, method] = k.split('.')
      const l = leftIdx[k] ?? 0
      const rItem = (comparison.right.report as any[]).find(x => `${x.contract}.${x.method}` === k)
      const r = rItem ? rItem.executionGasAverage : 0
      rows.push({ key: k, contract, method, left: l, right: r, delta: r - l })
    }
    return rows.sort((a,b)=> Math.abs(b.delta) - Math.abs(a.delta))
  }, [comparison])

  const [onchainAddr, setOnchainAddr] = useState('')
  const [onchain, setOnchain] = useState<any[]>([])
  const [watches, setWatches] = useState<any[]>([])

  useEffect(() => {
    if (!token) return
    // load repos for dropdown
    api.get('/repos', { headers }).then(r => setRepos(r.data.repos || [])).catch(() => {})
  }, [token])

  useEffect(() => {
    if (!token) return
    if (owner && repo) {
      api.get('/branches', { params: { owner, repo }, headers }).then(r => setBranches(r.data.branches || [])).catch(() => setBranches([]))
      api.get('/reports', { params: { owner, repo, branch }, headers }).then(r => setReports(r.data.items || [])).catch(() => setReports([]))
    }
  }, [token, owner, repo, branch])

  useEffect(() => {
    if (!token) return
    // SSE auto-refresh
    const es = new EventSource(`${baseURL}/reports/stream?token=${encodeURIComponent(token)}`)
    es.onmessage = () => {}
    es.addEventListener('report', (ev: MessageEvent) => {
      try {
        const payload = JSON.parse(ev.data)
        if (payload?.type === 'new-report') {
          const r = payload.report
          if (r.owner === owner && r.repo === repo && (!branch || r.branch === branch)) {
            // refetch latest list
            api.get('/reports', { params: { owner, repo, branch }, headers }).then(res => setReports(res.data.items || []))
          }
        }
      } catch {}
    })
    es.addEventListener('watch', async (_ev: MessageEvent) => {
      await loadWatches()
    })
    es.addEventListener('onchain', async (ev: MessageEvent) => {
      try {
        const p = JSON.parse(ev.data)
        if (p?.contract && p.contract === onchainAddr) {
          await loadOnchain()
        }
      } catch {}
    })
    es.onerror = () => {}
    return () => es.close()
  }, [token, owner, repo, branch])

  const connectRepo = async () => {
    await api.post('/repos/connect', { owner, repo, defaultBranch: branch }, { headers })
    alert('Repo connected and initial gas run requested.')
  }

  const doCompare = async () => {
    if (!left || !right) return
    const { data } = await api.get('/reports/compare', { params: { leftId: left, rightId: right }, headers })
    setComparison(data)
  }

  const loadOnchain = async () => {
    if (!onchainAddr) return
    const { data } = await api.get(`/onchain/${onchainAddr}`, { headers })
    setOnchain(data.items || [])
  }

  const loadWatches = async () => {
    const { data } = await api.get('/onchain/watches', { headers })
    setWatches(data.items || [])
  }

  const addWatch = async () => {
    if (!onchainAddr) return
    await api.post('/onchain/watches', { contract: onchainAddr }, { headers })
    setOnchainAddr('')
    await loadWatches()
  }

  const removeWatch = async (contract: string) => {
    await api.delete(`/onchain/watches/${contract}`, { headers })
    await loadWatches()
  }

  useEffect(() => { if (token) loadWatches() }, [token])

  if (!token) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="p-8 bg-white rounded shadow w-full max-w-md text-center space-y-4">
          <h1 className="text-2xl font-semibold">Gas Cost Monitor</h1>
          <p className="text-gray-600">Sign-In with Ethereum (SIWE)</p>
          <button onClick={login} className="px-4 py-2 bg-black text-white rounded">Connect Wallet</button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen p-6 space-y-6 bg-gray-50">
      <div className="flex items-center justify-between">
        <div className="text-gray-700 font-medium">Connected: {address}</div>
        <button onClick={logout} className="px-3 py-1 border rounded hover:bg-gray-100">Logout</button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="p-5 bg-white rounded-xl shadow">
          <h2 className="font-semibold mb-3 text-lg">Connect GitHub Repo</h2>
          <div className="space-y-2">
            <input value={owner} onChange={e=>setOwner(e.target.value)} placeholder="owner" className="w-full border p-2 rounded focus:outline-none focus:ring" />
            <input value={repo} onChange={e=>setRepo(e.target.value)} placeholder="repo" className="w-full border p-2 rounded focus:outline-none focus:ring" />
            <input value={branch} onChange={e=>setBranch(e.target.value)} placeholder="default branch" className="w-full border p-2 rounded focus:outline-none focus:ring" />
            <button onClick={connectRepo} className="px-3 py-2 bg-blue-600 hover:bg-blue-700 transition text-white rounded">Connect & Run</button>
          </div>
        </div>

        <div className="p-5 bg-white rounded-xl shadow lg:col-span-2">
          <h2 className="font-semibold mb-3 text-lg">Latest Reports</h2>
          <div className="flex gap-2 mb-3">
            <select value={`${owner}/${repo}`} onChange={e=>{ const [o,r] = e.target.value.split('/'); setOwner(o||''); setRepo(r||'') }} className="border p-2 rounded focus:outline-none">
              <option value="/">Select Repo</option>
              {repos.map((r:any)=> (
                <option key={`${r.owner}/${r.repo}`} value={`${r.owner}/${r.repo}`}>{r.owner}/{r.repo}</option>
              ))}
            </select>
            <select value={branch} onChange={e=>setBranch(e.target.value)} className="border p-2 rounded focus:outline-none">
              <option value="">All Branches</option>
              {branches.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="text-left">
                <tr>
                  <th className="p-2">_id</th>
                  <th className="p-2">repo</th>
                  <th className="p-2">branch</th>
                  <th className="p-2">pr</th>
                  <th className="p-2">createdAt</th>
                </tr>
              </thead>
              <tbody>
                {reports.map(r => (
                  <tr key={r._id} className="border-t">
                    <td className="p-2">{r._id}</td>
                    <td className="p-2">{r.owner}/{r.repo}</td>
                    <td className="p-2">{r.branch}</td>
                    <td className="p-2">{r.prNumber ?? '-'}</td>
                    <td className="p-2">{new Date(r.createdAt).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div className="p-5 bg-white rounded-xl shadow">
        <h2 className="font-semibold mb-3 text-lg">Compare Reports</h2>
        <div className="flex gap-2">
          <select value={left} onChange={e=>setLeft(e.target.value)} className="border p-2 rounded w-full">
            <option value="">Left report</option>
            {reports.map(r => <option key={r._id} value={r._id}>{r.owner}/{r.repo}@{r.branch} — {new Date(r.createdAt).toLocaleString()}</option>)}
          </select>
          <select value={right} onChange={e=>setRight(e.target.value)} className="border p-2 rounded w-full">
            <option value="">Right report</option>
            {reports.map(r => <option key={r._id} value={r._id}>{r.owner}/{r.repo}@{r.branch} — {new Date(r.createdAt).toLocaleString()}</option>)}
          </select>
          <button onClick={doCompare} className="px-3 py-2 bg-gray-900 hover:bg-black transition text-white rounded">Compare</button>
        </div>
        {comparison && (
          <div className="mt-4 space-y-6">
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={comparisonData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="key" tick={{ fontSize: 10 }} interval={0} angle={-30} textAnchor="end" height={70} />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="left" name="Left Avg Gas" fill="#64748b" />
                  <Bar dataKey="right" name="Right Avg Gas" fill="#0ea5e9" />
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="h-60">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={comparisonData}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="key" tick={{ fontSize: 10 }} interval={0} angle={-30} textAnchor="end" height={70} />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="delta" name="Delta (Right-Left)" fill="#ef4444" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>

      <div className="p-5 bg-white rounded-xl shadow">
        <h2 className="font-semibold mb-3 text-lg">On-chain Gas Usage</h2>
        <div className="flex gap-2 mb-3">
          <input value={onchainAddr} onChange={e=>setOnchainAddr(e.target.value)} placeholder="contract address" className="border p-2 rounded w-full" />
          <button onClick={loadOnchain} className="px-3 py-2 bg-green-600 hover:bg-green-700 transition text-white rounded">Load</button>
          <button onClick={addWatch} className="px-3 py-2 bg-blue-600 hover:bg-blue-700 transition text-white rounded">Watch</button>
        </div>
        <div className="mb-3">
          <div className="text-sm font-medium mb-1">Your watched contracts</div>
          <div className="flex flex-wrap gap-2">
            {watches.map(w => (
              <button key={w.contract} onClick={()=>{ setOnchainAddr(w.contract); loadOnchain(); }} className="px-2 py-1 border rounded text-sm bg-gray-50 hover:bg-white">
                {w.contract}
              </button>
            ))}
          </div>
        </div>
        <div className="h-72">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={onchain.slice().reverse()}>
              <defs>
                <linearGradient id="c" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#059669" stopOpacity={0.4}/>
                  <stop offset="95%" stopColor="#059669" stopOpacity={0}/>
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="blockNumber" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} />
              <Tooltip />
              <Area type="monotone" dataKey="gasUsed" stroke="#059669" fillOpacity={1} fill="url(#c)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        {onchain.length === 0 && (
          <div className="text-sm text-gray-500 mt-2">No on-chain activity for this contract in recent history.</div>
        )}
      </div>
    </div>
  )
}