import { BrowserRouter as Router, Routes, Route, Link } from 'react-router-dom';
import { Provider } from 'react-redux';
import { store } from './store/store';
import FunctionList from './components/FunctionList';
import FunctionDetail from './components/FunctionDetail';
import CreateFunction from './components/CreateFunction';
import './styles/main.scss';

function App() {
  return (
    <Provider store={store}>
      <Router>
        <div className="min-h-screen bg-gray-50">
          <nav className="bg-white shadow-sm">
            <div className="container mx-auto px-4">
              <div className="flex justify-between h-16">
                <div className="flex">
                  <Link
                    to="/"
                    className="flex items-center text-xl font-bold text-gray-800"
                  >
                    Function Flow
                  </Link>
                </div>
                <div className="flex items-center space-x-4">
                  <Link
                    to="/functions"
                    className="text-gray-600 hover:text-gray-900"
                  >
                    Functions
                  </Link>
                </div>
              </div>
            </div>
          </nav>

          <main className="py-6">
            <Routes>
              <Route path="/" element={<FunctionList />} />
              <Route path="/functions" element={<FunctionList />} />
              <Route path="/functions/new" element={<CreateFunction />} />
              <Route path="/functions/:id" element={<FunctionDetail />} />
            </Routes>
          </main>
        </div>
      </Router>
    </Provider>
  );
}

export default App;
