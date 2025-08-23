import React, { useEffect, useMemo, useState } from 'react'
import axios from 'axios'
import { generateNonce, SiweMessage } from 'siwe'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'

const api = axios.create({ baseURL: import.meta.env.VITE_API_BASE || 'http://localhost:4000' })

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
    const { data: { nonce } } = await api.post('/auth/nonce', { address: addr })
    const msg = new SiweMessage({
      domain: window.location.host,
      address: addr,
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

  const [reports, setReports] = useState<any[]>([])
  const [left, setLeft] = useState<string>('')
  const [right, setRight] = useState<string>('')
  const [comparison, setComparison] = useState<any | null>(null)

  const [onchainAddr, setOnchainAddr] = useState('')
  const [onchain, setOnchain] = useState<any[]>([])

  useEffect(() => {
    if (!token) return
    api.get('/reports', { headers }).then(r => setReports(r.data.items || [])).catch(() => {})
  }, [token])

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
    <div className="min-h-screen p-6 space-y-6">
      <div className="flex items-center justify-between">
        <div className="text-gray-700">Connected: {address}</div>
        <button onClick={logout} className="px-3 py-1 border rounded">Logout</button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="p-4 bg-white rounded shadow">
          <h2 className="font-semibold mb-3">Connect GitHub Repo</h2>
          <div className="space-y-2">
            <input value={owner} onChange={e=>setOwner(e.target.value)} placeholder="owner" className="w-full border p-2 rounded" />
            <input value={repo} onChange={e=>setRepo(e.target.value)} placeholder="repo" className="w-full border p-2 rounded" />
            <input value={branch} onChange={e=>setBranch(e.target.value)} placeholder="default branch" className="w-full border p-2 rounded" />
            <button onClick={connectRepo} className="px-3 py-2 bg-blue-600 text-white rounded">Connect & Run</button>
          </div>
        </div>

        <div className="p-4 bg-white rounded shadow lg:col-span-2">
          <h2 className="font-semibold mb-3">Latest Reports</h2>
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

      <div className="p-4 bg-white rounded shadow">
        <h2 className="font-semibold mb-3">Compare Reports</h2>
        <div className="flex gap-2">
          <input value={left} onChange={e=>setLeft(e.target.value)} placeholder="left report _id" className="border p-2 rounded w-full" />
          <input value={right} onChange={e=>setRight(e.target.value)} placeholder="right report _id" className="border p-2 rounded w-full" />
          <button onClick={doCompare} className="px-3 py-2 bg-gray-900 text-white rounded">Compare</button>
        </div>
        {comparison && (
          <div className="mt-4">
            <pre className="text-xs bg-gray-50 p-3 rounded overflow-auto">{JSON.stringify(comparison, null, 2)}</pre>
          </div>
        )}
      </div>

      <div className="p-4 bg-white rounded shadow">
        <h2 className="font-semibold mb-3">On-chain Gas Usage</h2>
        <div className="flex gap-2 mb-3">
          <input value={onchainAddr} onChange={e=>setOnchainAddr(e.target.value)} placeholder="contract address" className="border p-2 rounded w-full" />
          <button onClick={loadOnchain} className="px-3 py-2 bg-green-600 text-white rounded">Load</button>
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
      </div>
    </div>
  )
}