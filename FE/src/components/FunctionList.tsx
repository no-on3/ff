import React, { useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { Link } from 'react-router-dom';
import { RootState } from '../store/store';
import { fetchFunctions, deleteFunction } from '../store/functionSlice';
import { AppDispatch } from '../store/store';

const FunctionList: React.FC = () => {
  const dispatch = useDispatch<AppDispatch>();
  const { functions, loading, error } = useSelector((state: RootState) => state.functions);

  useEffect(() => {
    dispatch(fetchFunctions());
  }, [dispatch]);

  const handleDelete = (id: string) => {
    if (window.confirm('Are you sure you want to delete this function?')) {
      dispatch(deleteFunction(id));
    }
  };

  if (loading) {
    return <div className="flex justify-center items-center h-64">Loading...</div>;
  }

  if (error) {
    return <div className="text-red-600 p-4">{error}</div>;
  }

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-2xl font-bold">Functions</h1>
        <Link
          to="/functions/new"
          className="btn btn-primary"
        >
          Create New Function
        </Link>
      </div>

      <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3">
        {functions.map((func) => (
          <div key={func.id} className="card">
            <h2 className="text-xl font-semibold mb-2">{func.name}</h2>
            <p className="text-gray-600 mb-4">
              {func.runtime} · {func.memory} MB · {func.status}
            </p>
            <div className="flex justify-between items-center">
              <Link
                to={`/functions/${func.id}`}
                className="btn btn-secondary"
              >
                View Details
              </Link>
              <button
                onClick={() => handleDelete(func.id)}
                className="text-red-600 hover:text-red-800"
              >
                Delete
              </button>
            </div>
          </div>
        ))}
      </div>

      {functions.length === 0 && (
        <div className="text-center text-gray-500 mt-8">
          No functions found. Create one to get started!
        </div>
      )}
    </div>
  );
};

export default FunctionList;
