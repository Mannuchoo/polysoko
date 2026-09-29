import React from 'react';
import Header from './Header.jsx';
import Sidebar from './Sidebar.jsx';
import BalanceCard from './BalanceCard.jsx';
import './Layout.css';

export default function Layout({ user, onMenuClick, children }) {
  return (
    <div className="layout">
      <Header user={user} onMenuClick={onMenuClick} />

      <div className="layout-body">
        <aside className="sidebar">
          <BalanceCard balance={user?.balance ?? null} />
          <div className="sidebar-section">
            <h4 className="sidebar-title">Categories</h4>
            <nav className="sidebar-nav">
              <button className="sidebar-link active">All Markets</button>
              <button className="sidebar-link">Crypto</button>
              <button className="sidebar-link">Finance</button>
              <button className="sidebar-link">Tech</button>
              <button className="sidebar-link">Politics</button>
              <button className="sidebar-link">Sports</button>
              <button className="sidebar-link">Entertainment</button>
            </nav>
          </div>
        </aside>

        <main className="main-content">
          {children}
        </main>
      </div>
    </div>
  );
}