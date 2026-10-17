//! Secret storage used by the plugin host.
//!
//! Production builds forward to [`crate::keyring_store`]: the OS keyring in the
//! desktop app, a `0600` file in `codeg-server`. Unit tests use an in-process
//! map instead. GitHub's Linux runners have no Secret Service, so keyring calls
//! fail there, and on a developer machine the tests would otherwise write into
//! the real credential store.

#[cfg(not(test))]
pub(crate) fn get_secret(name: &str) -> Result<Option<String>, String> {
    crate::keyring_store::get_secret(name)
}

#[cfg(not(test))]
pub(crate) fn set_secret(name: &str, value: &str) -> Result<(), String> {
    crate::keyring_store::set_secret(name, value)
}

#[cfg(not(test))]
pub(crate) fn delete_secret(name: &str) -> Result<(), String> {
    crate::keyring_store::delete_secret(name)
}

#[cfg(test)]
pub(crate) use in_memory::{delete_secret, get_secret, set_secret};

#[cfg(test)]
mod in_memory {
    use std::collections::HashMap;
    use std::sync::{LazyLock, Mutex, MutexGuard, PoisonError};

    static STORE: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Mutex::default);

    fn store() -> MutexGuard<'static, HashMap<String, String>> {
        STORE.lock().unwrap_or_else(PoisonError::into_inner)
    }

    pub(crate) fn get_secret(name: &str) -> Result<Option<String>, String> {
        Ok(store().get(name).cloned())
    }

    pub(crate) fn set_secret(name: &str, value: &str) -> Result<(), String> {
        store().insert(name.to_string(), value.to_string());
        Ok(())
    }

    pub(crate) fn delete_secret(name: &str) -> Result<(), String> {
        store().remove(name);
        Ok(())
    }
}
