import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { CreateFailure, apiErrorMessage, createFailure } from '../lib/functions';
import { Function, FunctionUpdate, NewFunction, functionsApi } from '../services/api';

interface FunctionState {
  functions: Function[];
  currentFunction: Function | null;
  loading: boolean;
  error: string | null;
}

const initialState: FunctionState = {
  functions: [],
  currentFunction: null,
  loading: false,
  error: null,
};

// The thunks reject with the API's own message: Redux Toolkit would otherwise keep
// only the HTTP client's generic one ("Request failed with status code 400").
export const fetchFunctions = createAsyncThunk<Function[], void, { rejectValue: string }>(
  'functions/fetchAll',
  async (_arg, { rejectWithValue }) => {
    try {
      return (await functionsApi.getAllFunctions()).data;
    } catch (error) {
      return rejectWithValue(apiErrorMessage(error));
    }
  }
);

export const createFunction = createAsyncThunk<Function, NewFunction, { rejectValue: CreateFailure }>(
  'functions/create',
  async (functionData, { rejectWithValue }) => {
    try {
      return (await functionsApi.createFunction(functionData)).data;
    } catch (error) {
      return rejectWithValue(createFailure(error));
    }
  }
);

export const updateFunction = createAsyncThunk<Function, { id: string; data: FunctionUpdate }, { rejectValue: string }>(
  'functions/update',
  async ({ id, data }, { rejectWithValue }) => {
    try {
      return (await functionsApi.updateFunction(id, data)).data;
    } catch (error) {
      return rejectWithValue(apiErrorMessage(error));
    }
  }
);

export const deleteFunction = createAsyncThunk(
  'functions/delete',
  async (id: string) => {
    await functionsApi.deleteFunction(id);
    return id;
  }
);

const functionSlice = createSlice({
  name: 'functions',
  initialState,
  reducers: {
    setCurrentFunction: (state, action) => {
      state.currentFunction = action.payload;
    },
    clearCurrentFunction: (state) => {
      state.currentFunction = null;
    },
  },
  extraReducers: (builder) => {
    builder
      // Fetch functions
      .addCase(fetchFunctions.pending, (state) => {
        state.loading = true;
        state.error = null;
      })
      .addCase(fetchFunctions.fulfilled, (state, action) => {
        state.loading = false;
        state.functions = action.payload;
      })
      .addCase(fetchFunctions.rejected, (state, action) => {
        state.loading = false;
        state.error = action.payload ?? action.error.message ?? 'Failed to fetch functions';
      })
      // Create function
      .addCase(createFunction.fulfilled, (state, action) => {
        state.functions.push(action.payload);
      })
      // Update function
      .addCase(updateFunction.fulfilled, (state, action) => {
        const index = state.functions.findIndex(f => f.id === action.payload.id);
        if (index !== -1) {
          state.functions[index] = action.payload;
        }
      })
      // Delete function
      .addCase(deleteFunction.fulfilled, (state, action) => {
        state.functions = state.functions.filter(f => f.id !== action.payload);
      });
  },
});

export const { setCurrentFunction, clearCurrentFunction } = functionSlice.actions;
export default functionSlice.reducer;
