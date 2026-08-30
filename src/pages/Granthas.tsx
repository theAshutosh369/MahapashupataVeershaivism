import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import Navbar from '../components/Navbar';
import Footer from '../components/Footer';
import GranthasTree from '../components/GranthasTree';
import { listGranthas } from '../api_granthas';
import '../styles/pages/granthas.css';

function Granthas() {
    const [paths, setPaths] = useState<string[]>([]);
    const [selectedPath, setSelectedPath] = useState<string | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState('');

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                setLoading(true);
                setError('');
                const files = await listGranthas();
                if (!cancelled) {
                    setPaths(files);
                    setSelectedPath(files[0] ?? null);
                }
            } catch (err) {
                if (!cancelled) setError(err instanceof Error ? err.message : 'Unable to load Granthas.');
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const selectedParts = useMemo(() => (selectedPath ?? '').split('/').filter(Boolean), [selectedPath]);
    const selectedName = selectedParts[selectedParts.length - 1] ?? '';
    const selectedFolder = selectedParts.slice(0, -1).join(' / ');

    function publicFileUrl(filePath: string) {
        return `/data/${filePath.split('/').map(encodeURIComponent).join('/')}`;
    }

    return (
        <>
            <Navbar />
            <main className="container granthas-page">
                <div className="granthas-page-header">
                    <div>
                        <h1>Granthas</h1>
                        <p>Browse the Granthas exactly as they are organised under <code>public/data</code>.</p>
                    </div>
                    <div className="granthas-actions">
                        <Link className="granthas-action secondary" to="/dataset?mode=existing">Edit Dataset</Link>
                        <Link className="granthas-action primary" to="/dataset?mode=new">+ Create Dataset</Link>
                    </div>
                </div>

                {error && <div className="granthas-error">{error}</div>}

                <section className="granthas-layout">
                    <GranthasTree paths={paths} selectedPath={selectedPath} onSelect={setSelectedPath} />
                    <div className="granthas-detail">
                        {loading ? (
                            <div className="granthas-empty-state">Loading Granthas…</div>
                        ) : selectedPath ? (
                            <>
                                <div className="granthas-detail-topline">{selectedFolder || 'public/data'}</div>
                                <h2>{selectedName}</h2>
                                <p className="granthas-detail-path">public/data/{selectedPath}</p>
                                <div className="granthas-detail-actions">
                                    <a href={publicFileUrl(selectedPath)} target="_blank" rel="noreferrer" className="granthas-open-file">Open Grantha</a>
                                </div>
                            </>
                        ) : (
                            <div className="granthas-empty-state">Select a Grantha from the left panel.</div>
                        )}
                    </div>
                </section>
            </main>
            <Footer />
        </>
    );
}

export default Granthas;
